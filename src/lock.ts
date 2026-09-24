import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

/** Default time to wait for a contended lock before failing. */
export const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
/** A lock file older than this, or owned by a dead process, is treated as abandoned. */
export const DEFAULT_LOCK_STALE_MS = 120_000;
/** Base polling interval for contended locks; it grows exponentially with jitter. */
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 25;
/** Upper bound for the polling interval, so a long wait stays responsive. */
const MAX_LOCK_POLL_INTERVAL_MS = 500;
/** Default rename attempts used to absorb transient Windows file-lock errors. */
const DEFAULT_RENAME_RETRIES = 5;
/** Error codes raised when an antivirus, indexer or reader briefly holds a file. */
const TRANSIENT_RENAME_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

export interface FileLockOptions {
  /** Milliseconds to keep retrying before failing. Defaults to 60s. */
  timeoutMs?: number;
  /** Milliseconds after which an unreleased lock is reclaimed. Defaults to 120s. */
  staleMs?: number;
  /** Base backoff between acquisition attempts. Defaults to 25ms. */
  pollIntervalMs?: number;
  /** Human-readable owner description used in log messages. */
  label?: string;
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

/** Returns true when a lock was left behind by a dead owner or has expired. */
export function isLockStale(lockPath: string, staleMs: number = DEFAULT_LOCK_STALE_MS): boolean {
  const metadata = readLockMetadata(lockPath);
  if (typeof metadata?.pid === "number" && !isProcessAlive(metadata.pid)) {
    return true;
  }
  const createdAt = typeof metadata?.createdAt === "number" ? metadata.createdAt : null;
  if (createdAt !== null) {
    return Date.now() - createdAt > staleMs;
  }
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch (err) {
    logger.debug(
      `[lock] Could not stat lock file ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
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
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      return false;
    }
    throw err;
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
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  const label = options.label ?? path.basename(lockPath);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + timeoutMs;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; ; attempt++) {
    if (tryCreateLockFile(lockPath, token)) {
      return token;
    }
    if (isLockStale(lockPath, staleMs)) {
      logger.warn(`[lock] Reclaiming abandoned ${label} lock at ${lockPath}.`);
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        logger.debug(
          `[lock] Could not remove stale ${label} lock: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      continue;
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
 * Runs `task` while holding an exclusive cross-process lock at `lockPath`, releasing it
 * in a `finally` block. Concurrent callers queue with jittered exponential backoff, so
 * parallel CI jobs and monorepo linters sharing one cache serialize instead of racing.
 */
export async function withFileLock<T>(
  lockPath: string,
  task: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const token = await acquireFileLock(lockPath, options);
  try {
    return await task();
  } finally {
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
