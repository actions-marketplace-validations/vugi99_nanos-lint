import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { systemPaths } from "./paths.js";
import { getPackageRoot } from "./config.js";
import { logger } from "./logger.js";
import { AnnotationsError } from "./errors.js";

export const DOCGEN_REPO = "nanos-world/vscode-extension";
export const DOCGEN_BRANCH = "docgen-output";
export const RAW_ANNOTATIONS_URL =
  "https://raw.githubusercontent.com/nanos-world/vscode-extension/refs/heads/docgen-output/annotations.lua";
export const GITHUB_COMMITS_API =
  "https://api.github.com/repos/nanos-world/vscode-extension/commits/docgen-output";

export interface AnnotationsDate {
  year: number;
  month: number;
  day: number;
}

export interface AnnotationsMetadata {
  commitId: string;
  lastChecked: string;
  date: AnnotationsDate;
}

export const ANNOTATIONS_FILENAME = "annotations.lua";
export const METADATA_FILENAME = "metadata.json";

export function getTodayDateString(d: Date = new Date()): { dateStr: string; dateObj: AnnotationsDate } {
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    dateStr,
    dateObj: { year, month, day },
  };
}

export function getAnnotationsCacheDir(): string {
  return path.join(systemPaths.cache, "annotations");
}

export function getCachedAnnotationsFilePath(): string {
  return path.join(getAnnotationsCacheDir(), ANNOTATIONS_FILENAME);
}

export function getAnnotationsMetadataFilePath(): string {
  return path.join(getAnnotationsCacheDir(), METADATA_FILENAME);
}

export function readAnnotationsMetadata(cacheDir: string = getAnnotationsCacheDir()): AnnotationsMetadata | null {
  const metaPath = path.join(cacheDir, "metadata.json");
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(content) as AnnotationsMetadata;
    if (typeof parsed?.commitId === "string" && typeof parsed?.lastChecked === "string") {
      return parsed;
    }
    try {
      fs.unlinkSync(metaPath);
      logger.warn(`[annotations] Stale or invalid annotations metadata at ${metaPath} purged.`);
    } catch (unlinkErr) {
      logger.debug(`[annotations] Failed to unlink invalid metadata: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`);
    }
  } catch (err) {
    logger.debug(`Failed to parse annotations metadata: ${err instanceof Error ? err.message : String(err)}`);
    try {
      fs.unlinkSync(metaPath);
      logger.warn(`[annotations] Corrupted annotations metadata at ${metaPath} purged.`);
    } catch (unlinkErr) {
      logger.debug(`[annotations] Failed to unlink corrupted metadata: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`);
    }
  }
  return null;
}

export const MIN_ANNOTATIONS_SIZE_BYTES = 1000;

/**
 * Verifies that an annotations file exists, is a regular file, is of non-trivial size (>= MIN_ANNOTATIONS_SIZE_BYTES),
 * and begins with valid LuaLS metadata or nanos world definitions.
 */
export function isAnnotationsValid(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < MIN_ANNOTATIONS_SIZE_BYTES) {
      return false;
    }
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const header = buffer.toString("utf-8", 0, bytesRead).trimStart();
      return (
        header.startsWith("---@meta") ||
        header.includes("nanos world") ||
        header.includes("nanos-world")
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    logger.debug(
      `[annotations] Annotation validation failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

export async function fetchLatestCommitId(): Promise<string | null> {
  try {
    const headers: Record<string, string> = { "User-Agent": "nanos-lint" };
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(GITHUB_COMMITS_API, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { sha?: string };
      if (typeof data.sha === "string" && /^[0-9a-fA-F]{7,40}$/.test(data.sha)) {
        return data.sha;
      }
    }
  } catch (err) {
    logger.warn(`Failed to resolve latest annotations commit from GitHub: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

/**
 * Returns raw annotations URL, pinned to commit SHA if provided and valid.
 */
export function getRawAnnotationsUrl(commitSha?: string): string {
  if (commitSha && /^[0-9a-fA-F]{7,40}$/.test(commitSha)) {
    return `https://raw.githubusercontent.com/${DOCGEN_REPO}/${commitSha}/annotations.lua`;
  }
  return RAW_ANNOTATIONS_URL;
}

export async function fetchRawAnnotationsContent(commitSha?: string): Promise<string> {
  const url = getRawAnnotationsUrl(commitSha);
  const res = await fetch(url, {
    headers: { "User-Agent": "nanos-lint" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new AnnotationsError(
      `Failed to download annotations.lua: ${res.status} ${res.statusText}`,
      "ERR_ANNOTATIONS_DOWNLOAD",
      "Verify your internet connection and that GitHub raw endpoints are accessible."
    );
  }
  const text = await res.text();
  if (!text || text.length < MIN_ANNOTATIONS_SIZE_BYTES) {
    throw new AnnotationsError(
      "Downloaded annotations.lua appears truncated or invalid",
      "ERR_ANNOTATIONS_INVALID",
      "Retry downloading or pass a local annotations file via --annotations <path>."
    );
  }
  return text;
}

async function copyFileWithRetry(src: string, dest: string, maxRetries = 10): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.copyFileSync(src, dest);
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Updates the metadata lastChecked date atomically without modifying annotations.lua.
 */
export function updateLastCheckedDate(
  commitId: string,
  cacheDir: string = getAnnotationsCacheDir()
): AnnotationsMetadata {
  const { dateStr, dateObj } = getTodayDateString();
  const metadata: AnnotationsMetadata = {
    commitId,
    lastChecked: dateStr,
    date: dateObj,
  };
  fs.mkdirSync(cacheDir, { recursive: true });
  const metaPath = path.join(cacheDir, METADATA_FILENAME);
  const tempMetaPath = path.join(
    os.tmpdir(),
    `.metadata-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  try {
    fs.writeFileSync(tempMetaPath, JSON.stringify(metadata, null, 2), "utf-8");
    fs.copyFileSync(tempMetaPath, metaPath);
  } finally {
    try {
      if (fs.existsSync(tempMetaPath)) {
        fs.unlinkSync(tempMetaPath);
      }
    } catch (err) {
      logger.warn(`Failed to clean up temporary metadata file ${tempMetaPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return metadata;
}

/**
 * Downloads annotations.lua, writes it and the new metadata in a chained atomic transaction.
 * If any step fails, the previous cache state is reverted.
 */
export async function downloadAndCacheAnnotations(
  commitId: string,
  cacheDir: string = getAnnotationsCacheDir(),
  options?: { quiet?: boolean }
): Promise<string> {
  fs.mkdirSync(cacheDir, { recursive: true });

  const finalAnnotationsPath = path.join(cacheDir, ANNOTATIONS_FILENAME);
  const finalMetaPath = path.join(cacheDir, METADATA_FILENAME);

  const tempDir = path.join(
    os.tmpdir(),
    `nanos-ann-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const backupDir = path.join(
    os.tmpdir(),
    `nanos-ann-bak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  let hasBackup = false;

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    if (!options?.quiet) {
      if (commitId && commitId !== "unknown") {
        logger.info(`[annotations] Downloading nanos world API annotations (${commitId.slice(0, 7)})...`);
      } else {
        logger.info("[annotations] Downloading nanos world API annotations...");
      }
    }

    // Step 1: Download annotations text
    const content = await fetchRawAnnotationsContent(commitId);
    const tempAnnotationsPath = path.join(tempDir, ANNOTATIONS_FILENAME);
    fs.writeFileSync(tempAnnotationsPath, content, "utf-8");

    // Step 2: Prepare new metadata
    const { dateStr, dateObj } = getTodayDateString();
    const metadata: AnnotationsMetadata = {
      commitId,
      lastChecked: dateStr,
      date: dateObj,
    };
    const tempMetaPath = path.join(tempDir, METADATA_FILENAME);
    fs.writeFileSync(tempMetaPath, JSON.stringify(metadata, null, 2), "utf-8");

    // Step 3: Check if another concurrent worker already completed the cache population
    const existingMeta = readAnnotationsMetadata(cacheDir);
    if (
      existingMeta &&
      existingMeta.commitId === commitId &&
      fs.existsSync(finalAnnotationsPath) &&
      isAnnotationsValid(finalAnnotationsPath)
    ) {
      return finalAnnotationsPath;
    }

    // Step 4: Create backup of current cache state if files exist
    const oldAnnotationsExists = fs.existsSync(finalAnnotationsPath);
    const oldMetaExists = fs.existsSync(finalMetaPath);
    if (oldAnnotationsExists || oldMetaExists) {
      fs.mkdirSync(backupDir, { recursive: true });
      if (oldAnnotationsExists) {
        await copyFileWithRetry(finalAnnotationsPath, path.join(backupDir, ANNOTATIONS_FILENAME));
      }
      if (oldMetaExists) {
        await copyFileWithRetry(finalMetaPath, path.join(backupDir, METADATA_FILENAME));
      }
      hasBackup = true;
    }

    // Step 5: Promote temporary files to final paths with retry
    await copyFileWithRetry(tempAnnotationsPath, finalAnnotationsPath);
    await copyFileWithRetry(tempMetaPath, finalMetaPath);

    if (!options?.quiet) {
      if (commitId && commitId !== "unknown") {
        logger.info(`[annotations] Updated annotations.lua to commit ${commitId.slice(0, 7)}.`);
      } else {
        logger.info("[annotations] Updated annotations.lua.");
      }
    }

    return finalAnnotationsPath;
  } catch (err) {
    // Rollback to previous state on failure
    if (hasBackup && fs.existsSync(backupDir)) {
      try {
        const backupAnnotations = path.join(backupDir, ANNOTATIONS_FILENAME);
        const backupMeta = path.join(backupDir, METADATA_FILENAME);
        if (fs.existsSync(backupAnnotations)) {
          await copyFileWithRetry(backupAnnotations, finalAnnotationsPath);
        }
        if (fs.existsSync(backupMeta)) {
          await copyFileWithRetry(backupMeta, finalMetaPath);
        }
      } catch (rollbackErr) {
        logger.error(`Failed to restore annotations from backup during rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
      }
    }
    throw err;
  } finally {
    // Clean up tempDir and backupDir
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
    } catch (err) {
      logger.warn(`Failed to clean up annotations temporary or backup directory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export interface ResolveAnnotationsOptions {
  customPath?: string;
  cacheDir?: string;
  quiet?: boolean;
}

function validateCustomAnnotationsPath(filePath: string, source: "custom" | "env"): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    if (source === "custom") {
      throw new AnnotationsError(
        `Custom annotations file not found: ${resolved}`,
        "ERR_ANNOTATIONS_NOT_FOUND",
        "Verify that the path specified in --annotations exists and is accessible."
      );
    } else {
      throw new AnnotationsError(
        `Annotations file specified in environment not found: ${resolved}`,
        "ERR_ANNOTATIONS_ENV_NOT_FOUND",
        "Verify that the path specified in NANOS_ANNOTATIONS_PATH or NANOS_ANNOTATIONS exists."
      );
    }
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new AnnotationsError(
      source === "custom"
        ? `Custom annotations path is not a file: ${resolved}`
        : `Annotations path specified in environment is not a file: ${resolved}`,
      "ERR_ANNOTATIONS_NOT_A_FILE",
      source === "custom"
        ? "Verify that the path specified in --annotations points to a regular file, not a directory."
        : "Verify that the path specified in NANOS_ANNOTATIONS_PATH or NANOS_ANNOTATIONS points to a regular file, not a directory."
    );
  }

  if (stat.size === 0) {
    throw new AnnotationsError(
      source === "custom"
        ? `Custom annotations file is empty: ${resolved}`
        : `Annotations file specified in environment is empty: ${resolved}`,
      "ERR_ANNOTATIONS_INVALID",
      source === "custom"
        ? "Verify that the path specified in --annotations is a valid non-empty Lua annotations file."
        : "Verify that the path specified in NANOS_ANNOTATIONS_PATH or NANOS_ANNOTATIONS is a valid non-empty Lua annotations file."
    );
  }

  try {
    const fd = fs.openSync(resolved, "r");
    const buffer = Buffer.alloc(Math.min(stat.size, 512));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    if (buffer.subarray(0, bytesRead).includes(0)) {
      throw new AnnotationsError(
        source === "custom"
          ? `Custom annotations file appears to be a binary file: ${resolved}`
          : `Annotations file specified in environment appears to be a binary file: ${resolved}`,
        "ERR_ANNOTATIONS_INVALID",
        "Verify that the annotations file is a valid Lua text annotations file."
      );
    }
  } catch (err) {
    if (err instanceof AnnotationsError) {
      throw err;
    }
    // Ignore read errors
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
  // 1. CLI custom path
  if (options.customPath) {
    return validateCustomAnnotationsPath(options.customPath, "custom");
  }

  // 2. Environment variable
  const envPath = process.env.NANOS_ANNOTATIONS_PATH || process.env.NANOS_ANNOTATIONS;
  if (envPath) {
    return validateCustomAnnotationsPath(envPath, "env");
  }

  // 3. Bundled with package (release distribution)
  const bundled = path.join(getPackageRoot(), "annotations.lua");
  if (fs.existsSync(bundled) && isAnnotationsValid(bundled)) {
    return bundled;
  }

  // 4. User cache
  const cacheDir = options.cacheDir ?? getAnnotationsCacheDir();
  const cachedAnnotationsFile = path.join(cacheDir, ANNOTATIONS_FILENAME);
  const metadata = readAnnotationsMetadata(cacheDir);
  const { dateStr } = getTodayDateString();

  // If cached file exists but is corrupted or empty, purge it
  if (fs.existsSync(cachedAnnotationsFile) && !isAnnotationsValid(cachedAnnotationsFile)) {
    logger.warn("[annotations] Cached annotations.lua is corrupted or empty. Purging and refreshing...");
    try {
      fs.unlinkSync(cachedAnnotationsFile);
    } catch (err) {
      logger.warn(`[annotations] Failed to remove corrupted cached annotations: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // If already checked today and the file exists, return immediately without network call
  if (metadata && metadata.lastChecked === dateStr && fs.existsSync(cachedAnnotationsFile) && isAnnotationsValid(cachedAnnotationsFile)) {
    return cachedAnnotationsFile;
  }

  // Date has changed or cold cache: check GitHub repository
  const latestCommitId = await fetchLatestCommitId();

  if (latestCommitId) {
    if (metadata && metadata.commitId === latestCommitId && fs.existsSync(cachedAnnotationsFile) && isAnnotationsValid(cachedAnnotationsFile)) {
      // No changes upstream: update last checked date
      updateLastCheckedDate(latestCommitId, cacheDir);
      return cachedAnnotationsFile;
    }

    // Upstream has a new commit or cold cache: download & update
    return await downloadAndCacheAnnotations(latestCommitId, cacheDir, options);
  }

  // If GitHub API could not be reached (offline or rate limit):
  if (fs.existsSync(cachedAnnotationsFile) && isAnnotationsValid(cachedAnnotationsFile)) {
    try {
      updateLastCheckedDate(metadata?.commitId || "unknown", cacheDir);
    } catch (err) {
      logger.warn(`Failed to update lastChecked date for cached annotations: ${err instanceof Error ? err.message : String(err)}`);
    }
    return cachedAnnotationsFile;
  }

  // Cold cache or corrupted cache and API failed: try downloading raw file directly
  try {
    return await downloadAndCacheAnnotations("unknown", cacheDir, options);
  } catch (err) {
    // If offline and download fails, check if bundled annotations exist in package root
    if (fs.existsSync(bundled) && isAnnotationsValid(bundled)) {
      logger.info("[annotations] Network offline and cache unavailable. Falling back to bundled annotations.");
      return bundled;
    }

    const isFsError =
      Boolean(
        err &&
          typeof err === "object" &&
          "code" in err &&
          typeof (err as { code: unknown }).code === "string" &&
          ["EACCES", "EPERM", "ENOSPC", "EROFS", "EEXIST", "ENOENT"].includes(
            (err as { code: string }).code
          )
      ) ||
      (err instanceof Error &&
        /permission denied|read-only|no space left/i.test(err.message));

    if (isFsError) {
      throw new AnnotationsError(
        `Failed to resolve nanos world API annotations due to a filesystem error: ${err instanceof Error ? err.message : String(err)}. Please check directory permissions or pass a custom file with --annotations.`,
        "ERR_ANNOTATIONS_FS",
        "Check directory permissions for the cache directory or specify --annotations <path>.",
        { cause: err }
      );
    }
    throw new AnnotationsError(
      `Failed to resolve nanos world API annotations. Please check your network connection or pass a custom file with --annotations. (${err instanceof Error ? err.message : String(err)})`,
      "ERR_ANNOTATIONS_NETWORK",
      "Check your network connection, run 'nanos-lint warmup' when online, or specify --annotations <path>.",
      { cause: err }
    );
  }
}
