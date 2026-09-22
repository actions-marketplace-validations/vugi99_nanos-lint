import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { systemPaths } from "./paths.js";
import { getPackageRoot } from "./config.js";

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
  } catch {
    // Ignore parse error
  }
  return null;
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
  } catch {
    // Network error or rate limit
  }
  return null;
}

export async function fetchRawAnnotationsContent(): Promise<string> {
  const res = await fetch(RAW_ANNOTATIONS_URL, {
    headers: { "User-Agent": "nanos-lint" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Failed to download annotations.lua: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  if (!text || text.length < 1000) {
    throw new Error("Downloaded annotations.lua appears truncated or invalid");
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
    } catch {
      // Ignore cleanup error
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
        console.log(`[annotations] Downloading nanos world API annotations (${commitId.slice(0, 7)})...`);
      } else {
        console.log("[annotations] Downloading nanos world API annotations...");
      }
    }

    // Step 1: Download annotations text
    const content = await fetchRawAnnotationsContent();
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
      fs.statSync(finalAnnotationsPath).size >= 1000
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
        console.log(`[annotations] Updated annotations.lua to commit ${commitId.slice(0, 7)}.`);
      } else {
        console.log("[annotations] Updated annotations.lua.");
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
      } catch {
        // Ignore rollback copy error
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
    } catch {
      // Ignore cleanup error
    }
  }
}

export interface ResolveAnnotationsOptions {
  customPath?: string;
  cacheDir?: string;
  quiet?: boolean;
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
    const resolved = path.resolve(options.customPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Custom annotations file not found: ${resolved}`);
    }
    return resolved;
  }

  // 2. Environment variable
  const envPath = process.env.NANOS_ANNOTATIONS_PATH || process.env.NANOS_ANNOTATIONS;
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Annotations file specified in environment not found: ${resolved}`);
    }
    return resolved;
  }

  // 3. Bundled with package (release distribution)
  const bundled = path.join(getPackageRoot(), "annotations.lua");
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  // 4. User cache
  const cacheDir = options.cacheDir ?? getAnnotationsCacheDir();
  const cachedAnnotationsFile = path.join(cacheDir, ANNOTATIONS_FILENAME);
  const metadata = readAnnotationsMetadata(cacheDir);
  const { dateStr } = getTodayDateString();

  // If already checked today and the file exists, return immediately without network call
  if (metadata && metadata.lastChecked === dateStr && fs.existsSync(cachedAnnotationsFile)) {
    return cachedAnnotationsFile;
  }

  // Date has changed or cold cache: check GitHub repository
  const latestCommitId = await fetchLatestCommitId();

  if (latestCommitId) {
    if (metadata && metadata.commitId === latestCommitId && fs.existsSync(cachedAnnotationsFile)) {
      // No changes upstream: update last checked date
      updateLastCheckedDate(latestCommitId, cacheDir);
      return cachedAnnotationsFile;
    }

    // Upstream has a new commit or cold cache: download & update
    return await downloadAndCacheAnnotations(latestCommitId, cacheDir, options);
  }

  // If GitHub API could not be reached (offline or rate limit):
  if (fs.existsSync(cachedAnnotationsFile)) {
    try {
      updateLastCheckedDate(metadata?.commitId || "unknown", cacheDir);
    } catch {
      // Ignore write errors (e.g. read-only filesystem)
    }
    return cachedAnnotationsFile;
  }

  // Cold cache and API failed: try downloading raw file directly
  try {
    return await downloadAndCacheAnnotations("unknown", cacheDir, options);
  } catch (err) {
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
      throw new Error(
        `Failed to resolve nanos world API annotations due to a filesystem error: ${err instanceof Error ? err.message : String(err)}. Please check directory permissions or pass a custom file with --annotations.`,
        { cause: err }
      );
    }
    throw new Error(
      `Failed to resolve nanos world API annotations. Please check your network connection or pass a custom file with --annotations. (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }
}
