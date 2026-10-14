import fs from "node:fs";
import path from "node:path";
import { getPackageRoot } from "./config.js";
import { logger } from "./logger.js";
import { AnnotationsError } from "./errors.js";
import {
  ANNOTATIONS_FILENAME,
  getAnnotationsCacheDir,
  getTodayDateString,
  isAnnotationsValid,
  readAnnotationsMetadata,
  updateLastCheckedDate,
} from "./annotations-metadata.js";
import { downloadAndCacheAnnotations, fetchLatestCommitId } from "./annotations-download.js";

export * from "./annotations-metadata.js";
export * from "./annotations-download.js";

export interface ResolveAnnotationsOptions {
  customPath?: string;
  cacheDir?: string;
  offline?: boolean;
}

/**
 * Filesystem error codes that mean the cache is readable but not writable, which is normal
 * in sandboxed environments where only reading and process execution are permitted (#59).
 */
const CACHE_WRITE_DENIED_CODES: ReadonlySet<string> = new Set(["EROFS", "EACCES", "EPERM"]);

/** Relocation guidance shared by the read-only cache diagnostics. */
export const CACHE_LOCATION_HINT =
  "Set XDG_CACHE_HOME (Linux), LOCALAPPDATA (Windows) or HOME (macOS) to relocate the cache to a writable directory, or pass --annotations <path> with a local definitions file.";

/** Detects a filesystem denial that only prevents writing to the cache directory. */
export function isCacheWriteDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && CACHE_WRITE_DENIED_CODES.has(code)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /read-only file system|permission denied|operation not permitted/i.test(message);
}

/** Formats the short reason of a failed cache write, without repeating the error code. */
function describeError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof code !== "string") {
    return message;
  }
  return message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
}

/**
 * Refreshes the optional `lastChecked` bookkeeping date. A denied write leaves the cached
 * definitions intact and usable, so it warns and lets lint continue instead of failing (#59).
 */
function refreshCachedAnnotationsDate(commitId: string, cacheDir: string): void {
  try {
    updateLastCheckedDate(commitId, cacheDir);
  } catch (err) {
    const reason = describeError(err);
    if (isCacheWriteDenied(err)) {
      logger.warn(
        `[annotations] Annotations cache at ${cacheDir} is read-only (${reason}). Continuing with the existing valid cached annotations; only the optional refresh date could not be stored. ${CACHE_LOCATION_HINT}`,
      );
      return;
    }
    logger.warn(
      `[annotations] Could not store the annotations refresh date at ${cacheDir} (${reason}). Continuing with the existing valid cached annotations.`,
    );
  }
}

/** Validates that a user-supplied or environment-specified annotations path exists and is a valid file. */
function validateCustomAnnotationsPath(filePath: string, source: "custom" | "env"): string {
  const resolved = path.resolve(filePath);
  const isCustom = source === "custom";
  const targetDesc = isCustom
    ? "path specified in --annotations"
    : "path specified in NANOS_ANNOTATIONS_PATH or NANOS_ANNOTATIONS";
  if (!fs.existsSync(resolved)) {
    throw new AnnotationsError(
      isCustom
        ? `Custom annotations file not found: ${resolved}`
        : `Annotations file specified in environment not found: ${resolved}`,
      isCustom ? "ERR_ANNOTATIONS_NOT_FOUND" : "ERR_ANNOTATIONS_ENV_NOT_FOUND",
      `Verify that the ${targetDesc} exists and is accessible.`,
    );
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new AnnotationsError(
      isCustom
        ? `Custom annotations path is not a file: ${resolved}`
        : `Annotations path specified in environment is not a file: ${resolved}`,
      "ERR_ANNOTATIONS_NOT_A_FILE",
      `Verify that the ${targetDesc} points to a regular file, not a directory.`,
    );
  }

  if (stat.size === 0) {
    throw new AnnotationsError(
      isCustom
        ? `Custom annotations file is empty: ${resolved}`
        : `Annotations file specified in environment is empty: ${resolved}`,
      "ERR_ANNOTATIONS_INVALID",
      `Verify that the ${targetDesc} is a valid non-empty Lua annotations file.`,
    );
  }

  try {
    const fd = fs.openSync(resolved, "r");
    let isBinary = false;
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 512));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      isBinary = buffer.subarray(0, bytesRead).includes(0);
    } finally {
      fs.closeSync(fd);
    }
    if (isBinary) {
      throw new AnnotationsError(
        isCustom
          ? `Custom annotations file appears to be a binary file: ${resolved}`
          : `Annotations file specified in environment appears to be a binary file: ${resolved}`,
        "ERR_ANNOTATIONS_INVALID",
        "Verify that the annotations file is a valid Lua text annotations file.",
      );
    }
  } catch (err) {
    if (err instanceof AnnotationsError) {
      throw err;
    }
  }

  return resolved;
}

/**
 * Resolves the nanos world annotations.lua definitions file path.
 * Resolution precedence:
 * 1. CLI option (`customPath`)
 * 2. Environment variable (`NANOS_ANNOTATIONS_PATH` or `NANOS_ANNOTATIONS`)
 * 3. Bundled inside package root (`annotations.lua`)
 * 4. User cache (checked once per day from upstream GitHub)
 */
export async function resolveAnnotations(options: ResolveAnnotationsOptions = {}): Promise<string> {
  if (options.customPath) {
    return validateCustomAnnotationsPath(options.customPath, "custom");
  }

  const envPath = process.env.NANOS_ANNOTATIONS_PATH || process.env.NANOS_ANNOTATIONS;
  if (envPath) {
    return validateCustomAnnotationsPath(envPath, "env");
  }

  const bundled = path.join(getPackageRoot(), "annotations.lua");
  if (fs.existsSync(bundled) && isAnnotationsValid(bundled)) {
    return bundled;
  }

  const cacheDir = options.cacheDir ?? getAnnotationsCacheDir();
  const cachedAnnotationsFile = path.join(cacheDir, ANNOTATIONS_FILENAME);
  if (options.offline) {
    if (isAnnotationsValid(cachedAnnotationsFile)) return cachedAnnotationsFile;
    throw new AnnotationsError(
      `Offline: no usable local annotations.lua at ${cachedAnnotationsFile}.`,
      "ERR_ANNOTATIONS_OFFLINE",
      "Run 'nanos-lint warmup' online or specify --annotations <path>.",
    );
  }
  const metadata = readAnnotationsMetadata(cacheDir);
  const { dateStr } = getTodayDateString();

  if (fs.existsSync(cachedAnnotationsFile) && !isAnnotationsValid(cachedAnnotationsFile)) {
    logger.warn(
      "[annotations] Cached annotations.lua is corrupted or empty. Purging and refreshing...",
    );
    try {
      fs.unlinkSync(cachedAnnotationsFile);
    } catch (err) {
      logger.warn(
        `[annotations] Failed to remove corrupted cached annotations: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (
    metadata &&
    metadata.lastChecked === dateStr &&
    fs.existsSync(cachedAnnotationsFile) &&
    isAnnotationsValid(cachedAnnotationsFile)
  ) {
    return cachedAnnotationsFile;
  }

  const latestCommitId = await fetchLatestCommitId();

  if (latestCommitId) {
    if (
      metadata &&
      metadata.commitId === latestCommitId &&
      fs.existsSync(cachedAnnotationsFile) &&
      isAnnotationsValid(cachedAnnotationsFile)
    ) {
      refreshCachedAnnotationsDate(latestCommitId, cacheDir);
      return cachedAnnotationsFile;
    }

    try {
      return await downloadAndCacheAnnotations(latestCommitId, cacheDir);
    } catch (err) {
      // A restricted environment can forbid cache writes while still allowing every read:
      // the cached definitions stay valid, so keep linting instead of failing the run (#59).
      if (isCacheWriteDenied(err) && isAnnotationsValid(cachedAnnotationsFile)) {
        logger.warn(
          `[annotations] Cannot refresh the annotations cache at ${cacheDir} (${describeError(err)}). Continuing with the existing valid cached annotations read-only. ${CACHE_LOCATION_HINT}`,
        );
        return cachedAnnotationsFile;
      }
      throw toAnnotationsFailure(err, cacheDir);
    }
  }

  if (fs.existsSync(cachedAnnotationsFile) && isAnnotationsValid(cachedAnnotationsFile)) {
    refreshCachedAnnotationsDate(metadata?.commitId || "unknown", cacheDir);
    return cachedAnnotationsFile;
  }

  try {
    return await downloadAndCacheAnnotations("unknown", cacheDir);
  } catch (err) {
    if (fs.existsSync(bundled) && isAnnotationsValid(bundled)) {
      logger.info(
        "[annotations] Network offline and cache unavailable. Falling back to bundled annotations.",
      );
      return bundled;
    }

    throw toAnnotationsFailure(err, cacheDir);
  }
}

/**
 * Classifies a failed annotations download or cache write into an actionable error, so a
 * denied cache write is never reported as a network problem (#59).
 */
function toAnnotationsFailure(err: unknown, cacheDir: string): Error {
  const isFsError =
    isCacheWriteDenied(err) ||
    Boolean(
      err &&
      typeof err === "object" &&
      "code" in err &&
      typeof (err as { code: unknown }).code === "string" &&
      ["ENOSPC", "EEXIST", "ENOENT"].includes((err as { code: string }).code),
    ) ||
    (err instanceof Error && /no space left/i.test(err.message));

  if (isFsError) {
    return new AnnotationsError(
      `Failed to resolve nanos world API annotations due to a filesystem error: ${describeError(err)}. The annotations cache at ${cacheDir} is not writable and holds no usable copy.`,
      "ERR_ANNOTATIONS_FS",
      `Allow writes to the cache directory, or ${CACHE_LOCATION_HINT} Relocating the cache only fixes cache-write denials: a sandbox that also blocks process execution must additionally permit running the LuaLS binary.`,
      { cause: err },
    );
  }
  return new AnnotationsError(
    `Failed to resolve nanos world API annotations. Please check your network connection or pass a custom file with --annotations. (${err instanceof Error ? err.message : String(err)})`,
    "ERR_ANNOTATIONS_NETWORK",
    "Check your network connection, run 'nanos-lint warmup' when online, or specify --annotations <path>.",
    { cause: err },
  );
}

export interface CopyAnnotationsOptions {
  force?: boolean;
  annotationsPath?: string;
  cacheDir?: string;
  offline?: boolean;
}

const DEFAULT_COPY_TARGET = `.nanos-lint/${ANNOTATIONS_FILENAME}`;

/**
 * Copies nanos world annotations.lua definitions into a target file or directory.
 * A target counts as a directory when it ends with a separator, already is a directory,
 * or does not end in `.lua` (case-insensitively).
 */
export async function copyAnnotations(
  targetPath: string = DEFAULT_COPY_TARGET,
  options: CopyAnnotationsOptions = {},
): Promise<string> {
  let resolvedTarget = path.resolve(targetPath);
  const isDirectoryTarget =
    targetPath.endsWith("/") ||
    targetPath.endsWith("\\") ||
    (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) ||
    path.extname(resolvedTarget).toLowerCase() !== ".lua";
  if (isDirectoryTarget) {
    resolvedTarget = path.join(resolvedTarget, ANNOTATIONS_FILENAME);
  }

  if (fs.existsSync(resolvedTarget) && !options.force) {
    throw new AnnotationsError(
      `Target annotations file already exists: ${resolvedTarget}. Use --force to overwrite.`,
      "ERR_ANNOTATIONS_EXISTS",
      "Pass --force to overwrite the existing annotations file.",
    );
  }

  const sourcePath = options.annotationsPath
    ? validateCustomAnnotationsPath(options.annotationsPath, "custom")
    : await resolveAnnotations({ cacheDir: options.cacheDir, offline: options.offline });

  const targetDir = path.dirname(resolvedTarget);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourcePath, resolvedTarget);

  return resolvedTarget;
}
