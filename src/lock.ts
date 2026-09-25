import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

/** Default time to wait for a contended lock before failing. */
export const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
/** A lock file older than this, or owned by a dead process, is treated as abandoned. */
export const DEFAULT_LOCK_STALE_MS = 30_000;
/** Base polling interval for contended locks; it grows exponentially with jitter. */
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 25;
/** Upper bound for the polling interval, so a long wait stays responsive. */
const MAX_LOCK_POLL_INTERVAL_MS = 500;
/** Upper bound for the automatic heartbeat interval, keeping it responsive. */
const MAX_LOCK_HEARTBEAT_INTERVAL_MS = 15_000;
/** Default rename attempts used to absorb transient Windows file-lock errors. */
const DEFAULT_RENAME_RETRIES = 5;
/**
 * A dead-looking lock is only reclaimed once it is at least this old. A single liveness
 * verdict (which can be wrong on Windows, where a live sibling may be reported as gone)
 * must never be enough to break a freshly created lock.
 */
export const DEFAULT_RECLAIM_GRACE_MS = 1_000;
/** Create failures that mean "the lock is there / being swapped", not "cannot lock". */
const CONTENDED_CREATE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Error codes raised when an antivirus, indexer or reader briefly holds a file. */
const TRANSIENT_RENAME_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

export interface FileLockOptions {
  /** Milliseconds to keep retrying before failing. Defaults to 60s. */
  timeoutMs?: number;
  /** Milliseconds after which an unreleased lock is reclaimed. Defaults to 30s. */
  staleMs?: number;
  /** Minimum age before an abandoned-looking lock may be reclaimed. Defaults to 1s. */
  reclaimGraceMs?: number;
  /** Base backoff between acquisition attempts. Defaults to 25ms. */
  pollIntervalMs?: number;
  /** Human-readable owner description used in log messages. */
  label?: string;
  /**
   * Heartbeat interval in milliseconds to touch the lock file; defaults to staleMs / 4 (capped at 15s),
   * or disabled (0) when staleMs <= 0.
   */
  heartbeatIntervalMs?: number;
}

export interface AtomicWriteOptions {
  /** Rename attempts before giving up. Defaults to 5. */
  retries?: number;
}

interface LockMetadata {
  pid?: number;
  createdAt?: number;
  token?: string;
}

/** Blocks the current thread for a few milliseconds without any dependency. */
function sleepSync(ms: number): void {
  const started = Date.now();
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - started < ms) {
    Atomics.wait(wait, 0, 0, Math.max(1, ms - (Date.now() - started)));
  }
}

/** Asynchronous sleep used between lock acquisition attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns whether a process id belongs to a live process. */
function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Reads the JSON metadata a lock owner wrote, returning null when it is unreadable. */
function readLockMetadata(lockPath: string): LockMetadata | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockMetadata;
  } catch (err) {
    logger.debug(
      `[lock] Could not read lock metadata at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Returns the most recent activity timestamp (createdAt or mtime) for a lock file. */
function readLockActiveTime(lockPath: string, metadata?: LockMetadata | null): number | null {
  const meta = metadata !== undefined ? metadata : readLockMetadata(lockPath);
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    logger.debug(
      `[lock] Could not stat lock file ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const createdAt = typeof meta?.createdAt === "number" ? meta.createdAt : null;
  if (createdAt !== null && mtimeMs !== null) {
    return Math.max(createdAt, mtimeMs);
  }
  return createdAt ?? mtimeMs;
}

/** Returns true when a lock was left behind by a dead owner or has expired. */
export function isLockStale(lockPath: string, staleMs: number = DEFAULT_LOCK_STALE_MS): boolean {
  const metadata = readLockMetadata(lockPath);
  if (typeof metadata?.pid === "number" && !isProcessAlive(metadata.pid)) {
    return true;
  }
  const activeTime = readLockActiveTime(lockPath, metadata);
  if (activeTime !== null) {
    return Date.now() - activeTime > staleMs;
  }
  return false;
}

/**
 * Atomically creates the lock file with `O_CREAT | O_EXCL` semantics, so exactly one
 * process wins the race. `fs.openSync(..., "wx")` is the cross-platform primitive used
 * instead of a dependency.
 */
function tryCreateLockFile(lockPath: string, token: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), token } satisfies LockMetadata),
      );
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return false;
    }
    // Windows reports EPERM/EACCES/EBUSY instead of EEXIST while another process is
    // deleting or swapping the lock file, so an existing path means contention.
    if (typeof code === "string" && CONTENDED_CREATE_CODES.has(code) && fs.existsSync(lockPath)) {
      logger.debug(
        `[lock] Creating ${lockPath} failed with ${code} while the lock exists; treating it as contention.`,
      );
      return false;
    }
    throw err;
  }
}

/** Returns the age of a lock file in milliseconds, from its metadata or its mtime. */
function lockAgeMs(lockPath: string): number {
  const activeTime = readLockActiveTime(lockPath);
  if (activeTime !== null) {
    return Math.max(0, Date.now() - activeTime);
  }
  return Number.POSITIVE_INFINITY;
}

/** Confirms that a lock file still carries the token written by this process. */
function ownsLockFile(lockPath: string, token: string): boolean {
  return readLockMetadata(lockPath)?.token === token;
}

/**
 * Deletes an abandoned lock, but only when the owner token is still the one the staleness
 * decision was based on: without that check a lock created by another process between the
 * check and the unlink would be removed, letting two processes into the critical section.
 */
function reclaimAbandonedLock(lockPath: string, staleMs: number, label: string): boolean {
  const observed = readLockMetadata(lockPath);
  const observedToken = observed?.token ?? null;
  if (!isLockStale(lockPath, staleMs)) {
    return false;
  }
  if ((readLockMetadata(lockPath)?.token ?? null) !== observedToken) {
    logger.debug(`[lock] ${label} lock at ${lockPath} changed owner; leaving it alone.`);
    return false;
  }
  const ageMs = Math.round(lockAgeMs(lockPath));
  const reason =
    typeof observed?.pid === "number" && !isProcessAlive(observed.pid)
      ? `owner pid ${observed.pid} is gone`
      : `expired after ${ageMs}ms`;
  try {
    fs.unlinkSync(lockPath);
    logger.warn(
      `[lock] Reclaimed abandoned ${label} lock at ${lockPath} (${reason}, token ${observedToken ?? "none"}).`,
    );
    return true;
  } catch (err) {
    logger.debug(
      `[lock] Could not remove stale ${label} lock: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Backoff for the next acquisition attempt: exponential growth capped with jitter. */
function nextPollDelay(attempt: number, baseMs: number): number {
  const exponential = Math.min(baseMs * 2 ** Math.min(attempt, 8), MAX_LOCK_POLL_INTERVAL_MS);
  return exponential + Math.floor(Math.random() * baseMs);
}

/**
 * Waits until the lock file can be created, reclaiming abandoned locks (dead owner or
 * older than `staleMs`) along the way. Throws once `timeoutMs` elapses.
 */
async function acquireFileLock(lockPath: string, options: FileLockOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const reclaimGraceMs = options.reclaimGraceMs ?? DEFAULT_RECLAIM_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  const label = options.label ?? path.basename(lockPath);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + timeoutMs;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; ; attempt++) {
    if (tryCreateLockFile(lockPath, token)) {
      if (ownsLockFile(lockPath, token)) {
        return token;
      }
      // Another process reclaimed our file in the microseconds after creation; back off
      // instead of entering the critical section without a lock we still own.
      logger.debug(`[lock] Lost the ${label} lock right after creating it; retrying.`);
    }
    if (isLockStale(lockPath, staleMs)) {
      // A stale-looking lock that is younger than the grace period is left alone: the
      // liveness verdict behind it may be transient, but the deadline below must still
      // be honoured so a waiter can never spin here past its timeout.
      if (lockAgeMs(lockPath) >= reclaimGraceMs && reclaimAbandonedLock(lockPath, staleMs, label)) {
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the ${label} lock at ${lockPath}. ` +
          `Another nanos-lint process may be running; delete the file if it is stale.`,
      );
    }
    await sleep(nextPollDelay(attempt, pollIntervalMs));
  }
}

/** Releases a lock only when the token still belongs to the current caller. */
export function releaseFileLock(lockPath: string, token: string): void {
  const metadata = readLockMetadata(lockPath);
  if (metadata?.token !== token) {
    logger.debug(`[lock] Lock at ${lockPath} is owned by another process; leaving it in place.`);
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    logger.debug(
      `[lock] Could not release lock at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Refreshes the active timestamp of a lock file if the caller still owns it.
 * Uses `fs.utimesSync` non-destructively so it never overwrites another owner's lock metadata.
 */
export function touchLockFile(lockPath: string, token: string): boolean {
  const metadata = readLockMetadata(lockPath);
  if (metadata?.token !== token) {
    logger.debug(`[lock] Cannot touch lock at ${lockPath}: token mismatch or missing lock.`);
    return false;
  }
  try {
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
    return true;
  } catch (err) {
    logger.debug(
      `[lock] Could not touch lock at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Calculates the default heartbeat interval for a given staleness threshold. */
function defaultHeartbeatInterval(staleMs: number): number {
  if (staleMs <= 0) {
    return 0;
  }
  return Math.min(Math.max(1, Math.floor(staleMs / 4)), MAX_LOCK_HEARTBEAT_INTERVAL_MS);
}

/**
 * Runs `task` while holding an exclusive cross-process lock at `lockPath`, releasing it
 * in a `finally` block. Concurrent callers queue with jittered exponential backoff, so
 * parallel CI jobs and monorepo linters sharing one cache serialize instead of racing.
 */
export async function withFileLock<T>(
  lockPath: string,
  task: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const label = options.label ?? path.basename(lockPath);
  const resolvedOptions: FileLockOptions = {
    ...options,
    staleMs,
    label,
  };
  const token = await acquireFileLock(lockPath, resolvedOptions);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? defaultHeartbeatInterval(staleMs);
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let hasWarnedFailure = false;

  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      const metadata = readLockMetadata(lockPath);
      if (metadata?.token !== token) {
        if (heartbeatTimer !== undefined) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        logger.warn(`[lock] Lost ownership of ${label} lock at ${lockPath}; stopping heartbeat.`);
        return;
      }
      if (!touchLockFile(lockPath, token)) {
        if (!hasWarnedFailure) {
          hasWarnedFailure = true;
          logger.warn(
            `[lock] Failed to touch ${label} lock at ${lockPath}; heartbeat could not update timestamp.`,
          );
        }
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();
  }

  try {
    return await task();
  } finally {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    releaseFileLock(lockPath, token);
  }
}

/** Returns whether a failed rename is worth retrying on a busy file system. */
function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && TRANSIENT_RENAME_CODES.has(code);
}

/** Renames with bounded retries so parallel readers do not break a replacement. */
function renameWithRetrySync(tempPath: string, targetPath: string, retries: number): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (err) {
      if (attempt >= retries - 1 || !isTransientRenameError(err)) {
        throw err;
      }
      sleepSync(25 * (attempt + 1));
    }
  }
}

/** Removes a temporary file left behind by a failed atomic write. */
function cleanupTempFile(tempPath: string): void {
  try {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch (err) {
    logger.debug(
      `[lock] Could not remove temporary file ${tempPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Builds a unique sibling temp path so concurrent writers never share a scratch file. */
function buildTempPath(targetPath: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${suffix}.tmp`);
}

/**
 * Replaces `targetPath` with `data` atomically: the payload is written to a unique
 * sibling file first and then renamed over the target, so a concurrent reader either
 * sees the previous complete file or the new complete file, never a truncated one.
 */
export function writeAtomicFileSync(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = buildTempPath(targetPath);
  try {
    fs.writeFileSync(tempPath, data);
    renameWithRetrySync(tempPath, targetPath, options.retries ?? DEFAULT_RENAME_RETRIES);
  } catch (err) {
    cleanupTempFile(tempPath);
    throw err;
  }
}

/** Asynchronous counterpart of {@link writeAtomicFileSync} for awaited code paths. */
export async function writeAtomicFile(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = buildTempPath(targetPath);
  const retries = options.retries ?? DEFAULT_RENAME_RETRIES;
  try {
    await fs.promises.writeFile(tempPath, data);
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tempPath, targetPath);
        return;
      } catch (err) {
        if (attempt >= retries - 1 || !isTransientRenameError(err)) {
          throw err;
        }
        await sleep(25 * (attempt + 1));
      }
    }
  } catch (err) {
    cleanupTempFile(tempPath);
    throw err;
  }
}
