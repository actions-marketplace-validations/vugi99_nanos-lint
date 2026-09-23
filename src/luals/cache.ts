import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { systemPaths } from "../paths.js";
import { logger } from "../logger.js";
import { getPackageRoot } from "../config.js";
import { FALLBACK_LUALS_VERSION, sanitizeLuaLSVersion } from "./version.js";
import { getPlatformInfo } from "./platform.js";
import { isBinaryValid } from "./download.js";

export function getBaseLuaLSCacheDir(): string {
  return path.join(systemPaths.cache, "luals");
}

/**
 * Cache directory of a LuaLS version. `baseCacheDir` defaults to the system
 * cache and can be overridden to keep a caller isolated from it.
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

/**
 * Locates an existing, valid LuaLS directory for the specified version in the
 * primary cache (`baseCacheDir`), the legacy cache, or the package root.
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
