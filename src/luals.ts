import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { getPackageRoot } from "./config.js";
import { systemPaths } from "./paths.js";
import { fileUriToPath } from "./types.js";
import { logger } from "./logger.js";
import type { CheckOptions, CheckResult, DiagnosticReport, LuaRCConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export const FALLBACK_LUALS_VERSION = "3.19.1";
export const DEFAULT_LUALS_VERSION = "latest";

/**
 * Characters accepted in a LuaLS version/tag. Only ASCII letters, digits, dots,
 * dashes and underscores are allowed, so a version can never contain a path
 * separator, a drive letter or a traversal segment.
 */
const SAFE_VERSION_CHARS: ReadonlyMap<string, string> = new Map(
  [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._-"].map((ch) => [ch, ch])
);

const MAX_VERSION_LENGTH = 64;

/**
 * Validates a LuaLS version/tag and rebuilds it from the allow-list above.
 *
 * Version strings originate from untrusted sources: the GitHub releases API
 * response and user supplied `--luals-version` arguments. They are interpolated
 * into cache directory paths, download URLs, and the path of the binary that is
 * eventually executed, so they must be constrained to a single safe path
 * segment. Rebuilding the value character by character guarantees the returned
 * string only ever contains allow-listed characters (CodeQL: js/command-line-injection).
 *
 * @returns the normalized version (a single leading `v` is dropped), or `null`
 *          when the input cannot be used as a version tag.
 */
export function sanitizeLuaLSVersion(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) {
    return null;
  }

  let version = "";
  for (const ch of trimmed) {
    const allowed = SAFE_VERSION_CHARS.get(ch);
    if (allowed === undefined) {
      return null;
    }
    version += allowed;
  }

  // Drop a single leading "v" (e.g. "v3.19.1" -> "3.19.1").
  if (version.charCodeAt(0) === 0x76 /* "v" */) {
    version = version.slice(1);
  }

  // The first character must be alphanumeric, which rejects "", "v", ".", ".."
  // and any other value that could escape or alias a directory as a path segment.
  const first = version.charCodeAt(0);
  const startsAlphanumeric =
    (first >= 0x30 && first <= 0x39) || // 0-9
    (first >= 0x41 && first <= 0x5a) || // A-Z
    (first >= 0x61 && first <= 0x7a); // a-z

  return startsAlphanumeric ? version : null;
}

/**
 * Escapes single quotes for safe PowerShell single-quoted string interpolation.
 */
export function escapePowerShellSingleQuote(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * Fetches the latest available LuaLS release tag from the GitHub API.
 * Returns null if the request fails, times out, or receives an invalid tag.
 */
export async function fetchLatestLuaLSVersionFromGitHub(): Promise<string | null> {
  try {
    const headers: Record<string, string> = { "User-Agent": "nanos-lint" };
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(
      "https://api.github.com/repos/LuaLS/lua-language-server/releases/latest",
      {
        headers,
        signal: AbortSignal.timeout(5000),
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      // The response body is untrusted input: only use it when it is a valid tag.
      const version = typeof data.tag_name === "string" ? sanitizeLuaLSVersion(data.tag_name) : null;
      if (version) {
        return version;
      }
    }
  } catch (err) {
    logger.debug(
      `[luals] Failed to resolve latest LuaLS version from GitHub API: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return null;
}

/**
 * Resolves the latest available LuaLS release tag from the GitHub API,
 * falling back to FALLBACK_LUALS_VERSION if offline or unreachable.
 */
export async function resolveLatestLuaLSVersion(): Promise<string> {
  const version = await fetchLatestLuaLSVersionFromGitHub();
  return version || FALLBACK_LUALS_VERSION;
}

/**
 * Resolves a version string ("latest" -> actual tag).
 *
 * @throws when an explicitly requested version is not a valid tag.
 */
export async function resolveLuaLSVersion(version?: string): Promise<string> {
  if (!version || version === "latest") {
    return await resolveLatestLuaLSVersion();
  }
  const sanitized = sanitizeLuaLSVersion(version);
  if (!sanitized) {
    throw new Error(
      `Invalid LuaLS version: "${version}". Expected a release tag such as "3.19.1", or "latest".`
    );
  }
  return sanitized;
}

export interface PlatformInfo {
  platform: "win32" | "linux" | "darwin";
  arch: "x64" | "arm64" | "ia32";
  assetName: string;
  binaryRelativePath: string;
}

export function getPlatformInfo(version: string = FALLBACK_LUALS_VERSION): PlatformInfo {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    if (arch === "x64") {
      return {
        platform: "win32",
        arch: "x64",
        assetName: `lua-language-server-${version}-win32-x64.zip`,
        binaryRelativePath: path.join("bin", "lua-language-server.exe"),
      };
    }
    throw new Error(`Unsupported Windows architecture: ${arch}. Supported: x64`);
  }

  if (platform === "linux") {
    if (arch === "x64") {
      return {
        platform: "linux",
        arch: "x64",
        assetName: `lua-language-server-${version}-linux-x64.tar.gz`,
        binaryRelativePath: path.join("bin", "lua-language-server"),
      };
    }
    if (arch === "arm64") {
      return {
        platform: "linux",
        arch: "arm64",
        assetName: `lua-language-server-${version}-linux-arm64.tar.gz`,
        binaryRelativePath: path.join("bin", "lua-language-server"),
      };
    }
    throw new Error(`Unsupported Linux architecture: ${arch}. Supported: x64, arm64`);
  }

  if (platform === "darwin") {
    const archName = arch === "arm64" ? "arm64" : "x64";
    return {
      platform: "darwin",
      arch: arch as "x64" | "arm64",
      assetName: `lua-language-server-${version}-darwin-${archName}.tar.gz`,
      binaryRelativePath: path.join("bin", "lua-language-server"),
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

export function getBaseLuaLSCacheDir(): string {
  return path.join(systemPaths.cache, "luals");
}

/**
 * Returns the cache directory of a LuaLS version.
 *
 * @param version       LuaLS version/tag.
 * @param baseCacheDir  Base directory holding the version sub-directories.
 *                      Defaults to the platform system cache. Injecting a
 *                      different directory (see `ResolveLuaLSOptions.cacheDir`)
 *                      keeps a caller fully isolated from the shared cache.
 */
export function getCacheDir(
  version: string = FALLBACK_LUALS_VERSION,
  baseCacheDir: string = getBaseLuaLSCacheDir()
): string {
  return path.join(baseCacheDir, version);
}

/**
 * Returns the legacy cache directory used in nanos-lint <= 2.2.1.
 */
export function getLegacyCacheDir(version: string = FALLBACK_LUALS_VERSION): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "nanos-lint", "luals", version);
}

export const LUALS_METADATA_FILENAME = "metadata.json";

export interface LuaLSMetadata {
  lastCheckedWeek: string;
  latestVersion: string;
  lastCheckedDate?: string;
}

/**
 * Calculates the ISO 8601 week string for a given date in the format 'YYYY-Www' (e.g. '2026-W39').
 */
export function getIsoWeek(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function getLuaLSMetadataPath(baseCacheDir: string = getBaseLuaLSCacheDir()): string {
  return path.join(baseCacheDir, LUALS_METADATA_FILENAME);
}

export function readLuaLSMetadata(baseCacheDir: string = getBaseLuaLSCacheDir()): LuaLSMetadata | null {
  const metaPath = getLuaLSMetadataPath(baseCacheDir);
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(content) as LuaLSMetadata;
    if (
      typeof parsed?.lastCheckedWeek === "string" &&
      typeof parsed?.latestVersion === "string"
    ) {
      return parsed;
    }
  } catch (err) {
    logger.debug(`[luals] Failed to parse LuaLS metadata: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

export function writeLuaLSMetadata(
  metadata: LuaLSMetadata,
  baseCacheDir: string = getBaseLuaLSCacheDir()
): void {
  try {
    fs.mkdirSync(baseCacheDir, { recursive: true });
    const metaPath = getLuaLSMetadataPath(baseCacheDir);
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
  } catch (err) {
    logger.warn(`[luals] Failed to write LuaLS metadata: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Lists all cached LuaLS versions in baseCacheDir that have a valid .complete marker
 * and a functional executable binary.
 */
export function listCachedLuaLSVersions(baseCacheDir: string = getBaseLuaLSCacheDir()): string[] {
  if (!fs.existsSync(baseCacheDir)) {
    return [];
  }
  try {
    const entries = fs.readdirSync(baseCacheDir, { withFileTypes: true });
    const versions: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const version = sanitizeLuaLSVersion(entry.name);
      if (!version) {
        continue;
      }
      const dirPath = path.join(baseCacheDir, entry.name);
      const marker = path.join(dirPath, ".complete");
      const info = getPlatformInfo(version);
      const bin = path.join(dirPath, info.binaryRelativePath);
      if (fs.existsSync(marker) && fs.existsSync(bin)) {
        try {
          if (fs.readFileSync(marker, "utf-8").trim() === version && isBinaryValid(bin)) {
            versions.push(version);
          }
        } catch (err) {
          logger.debug(`[luals] Error validating cached version ${version}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return versions;
  } catch (err) {
    logger.debug(`[luals] Failed to list cached LuaLS versions: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Removes older cached LuaLS version directories, preserving keepVersion,
 * hidden/temporary directories, and metadata files.
 */
export function cleanupOldCachedLuaLSVersions(
  keepVersion: string,
  baseCacheDir: string = getBaseLuaLSCacheDir()
): string[] {
  if (!fs.existsSync(baseCacheDir)) {
    return [];
  }
  const removed: string[] = [];
  try {
    const entries = fs.readdirSync(baseCacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name !== keepVersion) {
        const dirPath = path.join(baseCacheDir, entry.name);
        try {
          fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          removed.push(entry.name);
          logger.info(`[luals] Cleaned up older cached LuaLS version: ${entry.name}`);
        } catch (err) {
          logger.warn(
            `[luals] Failed to remove older cached LuaLS version at ${dirPath}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  } catch (err) {
    logger.debug(`[luals] Failed to clean up old LuaLS versions: ${err instanceof Error ? err.message : String(err)}`);
  }
  return removed;
}

export interface DownloadOptions {
  quiet?: boolean;
  reuseExisting?: boolean;
  /**
   * Base directory searched for an already installed copy of the requested
   * version when `reuseExisting` is enabled. Defaults to the platform system
   * cache (plus legacy and package-bundled locations).
   */
  cacheDir?: string;
}

/**
 * Locates an existing, valid LuaLS directory for the specified version.
 * Checks primary system cache, legacy cache, and package bundled root.
 *
 * @param baseCacheDir Overrides the primary cache base directory (defaults to
 *                     the platform system cache).
 */
export function findExistingLuaLSDir(
  version: string,
  baseCacheDir: string = getBaseLuaLSCacheDir()
): string | null {
  const info = getPlatformInfo(version);

  // 1. Primary system cache
  const primaryCache = getCacheDir(version, baseCacheDir);
  const primaryBin = path.join(primaryCache, info.binaryRelativePath);
  const primaryMarker = path.join(primaryCache, ".complete");
  if (fs.existsSync(primaryMarker)) {
    try {
      if (fs.readFileSync(primaryMarker, "utf-8").trim() === version && isBinaryValid(primaryBin)) {
        return primaryCache;
      }
    } catch (err) {
      logger.debug(
        `[luals] Error checking primary LuaLS cache marker at ${primaryMarker}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 2. Legacy cache (nanos-lint <= 2.2.1)
  const legacyCache = getLegacyCacheDir(version);
  const legacyBin = path.join(legacyCache, info.binaryRelativePath);
  const legacyMarker = path.join(legacyCache, ".complete");
  if (fs.existsSync(legacyMarker)) {
    try {
      if (fs.readFileSync(legacyMarker, "utf-8").trim() === version && isBinaryValid(legacyBin)) {
        return legacyCache;
      }
    } catch (err) {
      logger.debug(
        `[luals] Error checking legacy LuaLS cache marker at ${legacyMarker}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 3. Package bundled root (release distributions)
  const pkgRoot = getPackageRoot();
  const pkgBin = path.join(pkgRoot, info.binaryRelativePath);
  if (fs.existsSync(pkgBin) && isBinaryValid(pkgBin)) {
    return pkgRoot;
  }

  return null;
}

/**
 * Verifies that a LuaLS binary exists, has non-trivial size, and is executable.
 */
export function isBinaryValid(binaryPath: string): boolean {
  if (!fs.existsSync(binaryPath)) {
    return false;
  }
  try {
    const stats = fs.statSync(binaryPath);
    if (!stats.isFile() || stats.size < 100_000) {
      return false;
    }
    const output = execFileSync(binaryPath, ["--version"], {
      timeout: 5000,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return /^\d+\.\d+\.\d+/.test(output.trim());
  } catch (err) {
    logger.debug(
      `[luals] Binary validation check failed for ${binaryPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

export async function downloadAndExtractLuaLS(
  version: string = DEFAULT_LUALS_VERSION,
  targetDir?: string,
  options?: DownloadOptions
): Promise<string> {
  const resolvedVersion = await resolveLuaLSVersion(version);
  const info = getPlatformInfo(resolvedVersion);
  const destDir = targetDir || getCacheDir(resolvedVersion);
  const binaryPath = path.join(destDir, info.binaryRelativePath);
  const completeMarker = path.join(destDir, ".complete");

  if (fs.existsSync(destDir)) {
    if (fs.existsSync(binaryPath) && fs.existsSync(completeMarker)) {
      try {
        const storedVersion = fs.readFileSync(completeMarker, "utf-8").trim();
        if (storedVersion === resolvedVersion && isBinaryValid(binaryPath)) {
          return binaryPath;
        }
      } catch (err) {
        logger.debug(
          `[luals] Failed to read complete marker at ${completeMarker}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    // destDir exists but is invalid/corrupted/stale: clean it up before downloading
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `[luals] Failed to remove stale or invalid cache dir ${destDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const parentDir = path.dirname(destDir);
  fs.mkdirSync(parentDir, { recursive: true });

  const tempDir = path.join(
    parentDir,
    `.${path.basename(destDir)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(tempDir, { recursive: true });

  const canReuse = options?.reuseExisting !== false;
  const existingSourceDir = canReuse
    ? findExistingLuaLSDir(
        resolvedVersion,
        options?.cacheDir ?? getBaseLuaLSCacheDir()
      )
    : null;
  const shouldCopyFromExisting =
    existingSourceDir !== null &&
    path.resolve(existingSourceDir) !== path.resolve(destDir);

  const url = `https://github.com/LuaLS/lua-language-server/releases/download/${resolvedVersion}/${info.assetName}`;
  const archivePath = path.join(tempDir, info.assetName);

  try {
    if (shouldCopyFromExisting) {
      if (!options?.quiet) {
        logger.info(`[luals] Reusing existing LuaLS ${resolvedVersion} installation from ${existingSourceDir}...`);
      }
      fs.cpSync(existingSourceDir, tempDir, { recursive: true });
    } else {
      if (!options?.quiet) {
        logger.info(`[luals] Downloading LuaLS ${resolvedVersion} from ${url}...`);
      }

      let response: Response | null = null;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url);
          if (res.ok && res.body) {
            response = res;
            break;
          }
          await res.body?.cancel();
          lastErr = new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
        } catch (err) {
          lastErr = err;
        }
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }

      if (!response || !response.body) {
        throw lastErr || new Error(`Failed to download ${url}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(archivePath, Buffer.from(arrayBuffer));

      if (!options?.quiet) {
        logger.info(`[luals] Extracting to ${destDir}...`);
      }

      try {
        // Both Windows 10+ and UNIX systems have tar built in
        await execFileAsync("tar", ["-xf", archivePath, "-C", tempDir]);
      } catch (tarErr) {
        // Fallback for PowerShell Expand-Archive on Windows if tar fails
        if (process.platform === "win32" && info.assetName.endsWith(".zip")) {
          await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Expand-Archive -Path '${escapePowerShellSingleQuote(archivePath)}' -DestinationPath '${escapePowerShellSingleQuote(tempDir)}' -Force`,
          ]);
        } else {
          throw tarErr;
        }
      }

      // Cleanup archive file
      try {
        fs.unlinkSync(archivePath);
      } catch (err) {
        logger.debug(
          `[luals] Failed to delete temporary archive ${archivePath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const tempBinaryPath = path.join(tempDir, info.binaryRelativePath);

    // Make executable on unix
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(tempBinaryPath, 0o755);
      } catch (err) {
        logger.warn(
          `[luals] Failed to chmod binary at ${tempBinaryPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Verify file exists, has non-trivial size, and is valid executable before promotion
    if (!fs.existsSync(tempBinaryPath) || fs.statSync(tempBinaryPath).size < 100_000) {
      throw new Error(`Failed to extract valid LuaLS binary to expected path: ${tempBinaryPath}`);
    }
    if (!isBinaryValid(tempBinaryPath)) {
      throw new Error(`Extracted LuaLS binary at ${tempBinaryPath} is invalid or non-functional.`);
    }

    // Write .complete marker in tempDir before promotion
    fs.writeFileSync(path.join(tempDir, ".complete"), resolvedVersion, "utf-8");

    // Atomic promotion with retry and race resolution
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tempDir, destDir);
        break;
      } catch (renameErr) {
        if (fs.existsSync(binaryPath) && isBinaryValid(binaryPath)) {
          // A concurrent worker already promoted destDir successfully
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (err) {
            logger.debug(
              `[luals] Failed to remove temp directory after concurrent promotion: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          if (!options?.quiet) {
            logger.info(`[luals] Ready: ${binaryPath}`);
          }
          return binaryPath;
        }
        if (attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        } else {
          // Clean up broken destDir if partially created or left corrupted during failed promotion
          if (fs.existsSync(destDir) && (!fs.existsSync(binaryPath) || !fs.existsSync(completeMarker))) {
            try {
              fs.rmSync(destDir, { recursive: true, force: true });
            } catch (err) {
              logger.warn(
                `[luals] Failed to clean up broken destination directory ${destDir}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          throw renameErr;
        }
      }
    }

    if (!options?.quiet) {
      logger.info(`[luals] Ready: ${binaryPath}`);
    }
    return binaryPath;
  } finally {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        logger.debug(
          `[luals] Failed to clean up temporary directory ${tempDir}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}

export interface ResolveLuaLSOptions {
  quiet?: boolean;
  /**
   * Base directory used for the LuaLS cache (the parent of the per-version
   * directories, the metadata file, and the temporary extraction folders).
   * Defaults to the platform system cache. Useful for tests and embedders that
   * must not touch the user's shared cache.
   */
  cacheDir?: string;
  /**
   * When `false`, an already installed copy of the requested version (legacy
   * cache or package bundle) is not reused and the archive is always fetched
   * from GitHub. Defaults to `true`.
   */
  reuseExisting?: boolean;
}

export async function resolveLuaLSBinary(
  version: string = DEFAULT_LUALS_VERSION,
  options?: ResolveLuaLSOptions
): Promise<string> {
  // 1. Environment variable override
  if (process.env.LUALS_BIN && fs.existsSync(process.env.LUALS_BIN)) {
    return process.env.LUALS_BIN;
  }

  // 2. Bundled with package (release distribution) - check early for default version to avoid network delay
  if (!version || version === "latest") {
    const defaultInfo = getPlatformInfo(FALLBACK_LUALS_VERSION);
    const defaultBundledPath = path.join(getPackageRoot(), defaultInfo.binaryRelativePath);
    if (fs.existsSync(defaultBundledPath) && isBinaryValid(defaultBundledPath)) {
      return defaultBundledPath;
    }
  }

  const isDefaultOrLatest = !version || version === "latest";

  // Cache base directory: the platform system cache unless the caller injected
  // an isolated one.
  const baseCacheDir = options?.cacheDir ?? getBaseLuaLSCacheDir();

  // When a specific version is explicitly requested (not "latest"):
  if (!isDefaultOrLatest) {
    const resolvedVersion = await resolveLuaLSVersion(version);
    const info = getPlatformInfo(resolvedVersion);

    // Bundled with package for explicitly requested version
    const bundledPath = path.join(getPackageRoot(), info.binaryRelativePath);
    if (fs.existsSync(bundledPath) && isBinaryValid(bundledPath)) {
      return bundledPath;
    }

    // User cache for explicitly requested version
    const cachedDir = getCacheDir(resolvedVersion, baseCacheDir);
    const cachedPath = path.join(cachedDir, info.binaryRelativePath);
    const completeMarker = path.join(cachedDir, ".complete");

    if (fs.existsSync(cachedPath)) {
      if (fs.existsSync(completeMarker)) {
        try {
          const storedVersion = fs.readFileSync(completeMarker, "utf-8").trim();
          if (storedVersion === resolvedVersion && isBinaryValid(cachedPath)) {
            return cachedPath;
          }
        } catch (err) {
          logger.debug(
            `[luals] Failed to read complete marker at ${completeMarker}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (!options?.quiet) {
        logger.warn(`[luals] Cached LuaLS binary at ${cachedPath} is corrupted or incomplete. Repairing...`);
      }
      try {
        fs.rmSync(cachedDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `[luals] Failed to remove corrupted cache directory ${cachedDir}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Probe legacy cache location from nanos-lint <= 2.2.1
    const legacyDir = getLegacyCacheDir(resolvedVersion);
    const legacyPath = path.join(legacyDir, info.binaryRelativePath);
    const legacyMarker = path.join(legacyDir, ".complete");

    if (fs.existsSync(legacyPath)) {
      let validLegacy = false;
      if (fs.existsSync(legacyMarker)) {
        try {
          const stored = fs.readFileSync(legacyMarker, "utf-8").trim();
          if (stored === resolvedVersion && isBinaryValid(legacyPath)) {
            validLegacy = true;
          }
        } catch (err) {
          logger.debug(
            `[luals] Failed to read legacy complete marker at ${legacyMarker}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else if (isBinaryValid(legacyPath)) {
        validLegacy = true;
      }

      if (validLegacy) {
        if (path.resolve(legacyDir) !== path.resolve(cachedDir)) {
          try {
            fs.mkdirSync(path.dirname(cachedDir), { recursive: true });
            fs.cpSync(legacyDir, cachedDir, { recursive: true });
            if (fs.existsSync(cachedPath) && isBinaryValid(cachedPath)) {
              return cachedPath;
            }
          } catch (err) {
            logger.warn(
              `[luals] Failed to migrate legacy cache from ${legacyDir} to ${cachedDir}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        return legacyPath;
      }
    }

    // In PATH
    try {
      const cmd = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(cmd, ["lua-language-server"]);
      const found = stdout.trim().split(/\r?\n/)[0];
      if (found && fs.existsSync(found) && isBinaryValid(found)) {
        return found;
      }
    } catch (err) {
      logger.debug(
        `[luals] LuaLS binary not found in PATH: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Download and cache explicit version
    return await downloadAndExtractLuaLS(
      resolvedVersion,
      getCacheDir(resolvedVersion, baseCacheDir),
      options
    );
  }

  // 3. Default/latest version: Weekly cache check & auto-cleanup
  const currentWeek = getIsoWeek();
  const metadata = readLuaLSMetadata(baseCacheDir);

  // Fast path: the latest version was already resolved during the current week
  // and its cached binary is still functional. This intentionally runs before
  // listCachedLuaLSVersions() so the common warm-cache path does not spawn the
  // LuaLS binary once per cached version just to enumerate the cache.
  if (metadata && metadata.lastCheckedWeek === currentWeek && metadata.latestVersion) {
    const info = getPlatformInfo(metadata.latestVersion);
    const cachedPath = path.join(
      getCacheDir(metadata.latestVersion, baseCacheDir),
      info.binaryRelativePath
    );
    if (isBinaryValid(cachedPath)) {
      return cachedPath;
    }
  }

  // Enumerate the cache only when the fast path did not produce a usable binary.
  const cachedVersions = listCachedLuaLSVersions(baseCacheDir);

  // Slow path within the same week: the recorded version is unusable, but
  // another fully validated cached version can still be reused without network.
  if (metadata && metadata.lastCheckedWeek === currentWeek && cachedVersions.length > 0) {
    const fallbackVersion = cachedVersions[0];
    const info = getPlatformInfo(fallbackVersion);
    return path.join(getCacheDir(fallbackVersion, baseCacheDir), info.binaryRelativePath);
  }

  // We need to check for updates (new week, missing metadata, or no valid binary in cache)
  const onlineTag = await fetchLatestLuaLSVersionFromGitHub();
  const today = new Date().toISOString().split("T")[0];

  let targetVersion: string;
  if (onlineTag) {
    targetVersion = onlineTag;
  } else if (metadata?.latestVersion && cachedVersions.includes(metadata.latestVersion)) {
    logger.info(`[luals] Network unreachable or rate limited; using cached LuaLS ${metadata.latestVersion}.`);
    targetVersion = metadata.latestVersion;
  } else if (cachedVersions.length > 0) {
    logger.info(`[luals] Network unreachable or rate limited; using cached LuaLS ${cachedVersions[0]}.`);
    targetVersion = cachedVersions[0];
  } else {
    targetVersion = FALLBACK_LUALS_VERSION;
  }

  // Update metadata with the current week and target version
  writeLuaLSMetadata(
    {
      lastCheckedWeek: currentWeek,
      latestVersion: targetVersion,
      lastCheckedDate: today,
    },
    baseCacheDir
  );

  const info = getPlatformInfo(targetVersion);
  const targetCacheDir = getCacheDir(targetVersion, baseCacheDir);
  const targetBinaryPath = path.join(targetCacheDir, info.binaryRelativePath);
  const completeMarker = path.join(targetCacheDir, ".complete");

  if (fs.existsSync(completeMarker) && isBinaryValid(targetBinaryPath)) {
    // Already downloaded and valid; clean up any older versions
    cleanupOldCachedLuaLSVersions(targetVersion, baseCacheDir);
    return targetBinaryPath;
  }

  // Check PATH as fallback before downloading if offline/unreachable
  if (!onlineTag) {
    try {
      const cmd = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(cmd, ["lua-language-server"]);
      const found = stdout.trim().split(/\r?\n/)[0];
      if (found && fs.existsSync(found) && isBinaryValid(found)) {
        return found;
      }
    } catch (err) {
      logger.debug(
        `[luals] LuaLS binary not found in PATH: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Download and extract latest LuaLS
  const downloadedBinary = await downloadAndExtractLuaLS(targetVersion, targetCacheDir, options);

  // If update is found, download latest LuaLS to replace the older one, remove the older one from cache afterwards
  cleanupOldCachedLuaLSVersions(targetVersion, baseCacheDir);

  return downloadedBinary;
}

export async function runLuaLSCheck(
  targetPath: string,
  configPath: string,
  options: CheckOptions
): Promise<CheckResult> {
  const absoluteTarget = path.resolve(targetPath);
  if (!fs.existsSync(absoluteTarget)) {
    throw new Error(`Target path does not exist: ${targetPath}`);
  }

  const binary =
    options.lualsBin ||
    (await resolveLuaLSBinary(options.lualsVersion, { quiet: options.quiet }));

  let checkDir = absoluteTarget;
  let targetFileOnly: string | null = null;

  if (fs.statSync(absoluteTarget).isFile()) {
    checkDir = path.dirname(absoluteTarget);
    targetFileOnly = absoluteTarget;
  }

  const tempOutputDir = systemPaths.temp;
  fs.mkdirSync(tempOutputDir, { recursive: true });
  const checkOutPath = path.join(
    tempOutputDir,
    `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );

  const args: string[] = [
    `--check=${checkDir}`,
    `--configpath=${path.resolve(configPath)}`,
    `--check_out_path=${checkOutPath}`,
    "--check_format=json",
  ];

  if (options.checklevel) {
    args.push(`--checklevel=${options.checklevel}`);
  }

  let execError: unknown = null;
  try {
    await execFileAsync(binary, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (err) {
    execError = err;
    logger.debug(
      `[luals] LuaLS process exited with error or non-zero status: ${err instanceof Error ? err.message : String(err)}`
    );
    // Process may exit with non-zero when diagnostics are found
  }

  let diagnostics: DiagnosticReport = {};
  let parseSucceeded = false;
  if (fs.existsSync(checkOutPath)) {
    try {
      const content = fs.readFileSync(checkOutPath, "utf-8");
      diagnostics = JSON.parse(content) as DiagnosticReport;
      parseSucceeded = true;
    } catch (err) {
      logger.error(
        `[luals] Failed to read or parse diagnostic output from ${checkOutPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      try {
        fs.unlinkSync(checkOutPath);
      } catch (err) {
        logger.debug(
          `[luals] Failed to delete check output file ${checkOutPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  if (!parseSucceeded) {
    const cacheHint = `(Cache location: ${getCacheDir()})`;
    if (execError) {
      throw new Error(
        `LuaLS check failed to execute or produce diagnostic output: ${execError instanceof Error ? execError.message : String(execError)}. ${cacheHint}`
      );
    }
    throw new Error(
      `LuaLS check failed to produce diagnostic output at: ${checkOutPath}. ${cacheHint}`
    );
  }

  // If a single file was requested, filter diagnostics to only that file
  if (targetFileOnly) {
    const filtered: DiagnosticReport = {};
    const normTarget = path.resolve(targetFileOnly).toLowerCase();
    for (const [rawUri, diags] of Object.entries(diagnostics)) {
      const filePath = fileUriToPath(rawUri);
      if (path.resolve(filePath).toLowerCase() === normTarget) {
        filtered[rawUri] = diags;
      }
    }
    diagnostics = filtered;
  }

  let totalProblems = 0;
  let totalErrors = 0;
  let totalWarnings = 0;
  let problemFiles = 0;

  for (const [_, diags] of Object.entries(diagnostics)) {
    if (diags.length > 0) {
      problemFiles += 1;
      totalProblems += diags.length;
      for (const d of diags) {
        if (d.severity === 1) {
          totalErrors += 1;
        } else if (d.severity === 2) {
          totalWarnings += 1;
        }
      }
    }
  }

  const passed = totalProblems === 0;
  const filesChecked = countCheckedFiles(targetPath, configPath);
  const totalFiles = passed ? filesChecked : problemFiles;

  return {
    passed,
    totalProblems,
    totalErrors,
    totalWarnings,
    totalFiles,
    totalFilesChecked: filesChecked,
    diagnostics,
  };
}

/**
 * Counts candidate Lua files within targetPath, taking ignoreDir and files.exclude into account.
 */
export function countCheckedFiles(targetPath: string, configPath?: string): number {
  const absPath = path.resolve(targetPath);
  if (!fs.existsSync(absPath)) {
    return 0;
  }

  if (fs.statSync(absPath).isFile()) {
    return absPath.toLowerCase().endsWith(".lua") ? 1 : 0;
  }

  let ignoreDirs: string[] = [".git", ".vscode", ".nanos-lint", "node_modules"];
  let excludePatterns: string[] = [];

  if (configPath && fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as LuaRCConfig;
      if (cfg.workspace?.ignoreDir) {
        ignoreDirs = cfg.workspace.ignoreDir;
      }
      if (cfg.files?.exclude) {
        excludePatterns = cfg.files.exclude;
      }
    } catch (err) {
      logger.warn(
        `[luals] Failed to parse config file for file counting at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const normIgnoreDirs = new Set(ignoreDirs.map((d) => d.replace(/\\/g, "/").toLowerCase()));

  function isExcluded(relPath: string): boolean {
    const norm = relPath.replace(/\\/g, "/");
    const baseName = path.posix.basename(norm);

    for (const pat of excludePatterns) {
      const normPat = pat.replace(/\\/g, "/");
      if (norm === normPat || baseName === normPat) return true;
      if (normPat.endsWith("/**")) {
        const dir = normPat.slice(0, -3);
        if (norm === dir || norm.startsWith(`${dir}/`)) return true;
      }
      if (norm.startsWith(`${normPat}/`)) return true;

      if (normPat.includes("*") || normPat.includes("?")) {
        // If pattern has no slash, it matches basename anywhere
        if (!normPat.includes("/")) {
          const baseRegexStr =
            "^" +
            normPat
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".") +
            "$";
          try {
            if (new RegExp(baseRegexStr, "i").test(baseName)) return true;
          } catch (err) {
            logger.debug(
              `[luals] Invalid regex for pattern "${normPat}": ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        // Convert glob with ** and * to regex matching full relPath
        let regexStr = normPat;
        const hasLeadingDoubleStar = regexStr.startsWith("**/");
        if (hasLeadingDoubleStar) {
          regexStr = regexStr.slice(3);
        }
        const hasTrailingDoubleStar = regexStr.endsWith("/**");
        if (hasTrailingDoubleStar) {
          regexStr = regexStr.slice(0, -3);
        }

        let escaped = regexStr
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\/\*\*\//g, "/(?:.*/)?")
          .replace(/\*\*/g, ".*")
          .replace(/(?<!\.)\*/g, "[^/]*")
          .replace(/\?/g, "[^/]");

        if (hasLeadingDoubleStar) {
          escaped = `(?:^|.*/)${escaped}`;
        }
        if (hasTrailingDoubleStar) {
          escaped = `${escaped}(?:/.*)?`;
        }

        try {
          if (new RegExp(`^${escaped}$`, "i").test(norm)) return true;
        } catch (err) {
          logger.debug(
            `[luals] Invalid glob regex for pattern "${normPat}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
    return false;
  }

  let count = 0;

  function walk(currentDir: string, relDir: string = "") {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      logger.debug(
        `[luals] Failed to read directory ${currentDir}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const relPath = relDir ? `${relDir}/${name}` : name;
      const fullPath = path.join(currentDir, name);

      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (() => {
            try {
              return fs.statSync(fullPath).isDirectory();
            } catch (err) {
              logger.debug(
                `[luals] Failed to stat symlink target ${fullPath}: ${err instanceof Error ? err.message : String(err)}`
              );
              return false;
            }
          })());

      if (isDirectory) {
        const lowerName = name.toLowerCase();
        if (normIgnoreDirs.has(lowerName) || normIgnoreDirs.has(relPath.toLowerCase())) {
          continue;
        }
        if (isExcluded(relPath) || isExcluded(`${relPath}/**`)) {
          continue;
        }
        walk(fullPath, relPath);
      } else if (entry.isFile() && name.toLowerCase().endsWith(".lua")) {
        if (!isExcluded(relPath)) {
          count++;
        }
      }
    }
  }

  walk(absPath);
  return count;
}

