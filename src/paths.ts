import fs from "node:fs";
import envPaths from "env-paths";
import { logger } from "./logger.js";

/**
 * System paths resolved for nanos-lint using cross-platform conventions
 * provided by env-paths (XDG on Linux, %LOCALAPPDATA%/%APPDATA% on Windows, ~/Library on macOS).
 */
export const systemPaths = envPaths("nanos-lint", { suffix: "" });

/**
 * Clears the nanos-lint cache directory.
 * Returns the path of the cleared cache directory, or null if it did not exist.
 */
export function cleanCache(targetDir: string = systemPaths.cache): string | null {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true });
    return targetDir;
  }
  return null;
}

/**
 * Recursively calculates total disk usage of a file or directory in bytes.
 * Handles missing paths and inaccessible files gracefully.
 */
export function getDirectorySize(targetPath: string): number {
  if (!fs.existsSync(targetPath)) {
    return 0;
  }
  let total = 0;
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return stat.size;
    }
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = `${targetPath}/${entry.name}`;
      try {
        if (entry.isDirectory()) {
          total += getDirectorySize(fullPath);
        } else if (entry.isFile()) {
          total += fs.statSync(fullPath).size;
        }
      } catch (err) {
        logger.debug(
          `[paths] Failed to stat entry ${fullPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (err) {
    logger.debug(
      `[paths] Failed to calculate directory size for ${targetPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return 0;
  }
  return total;
}

/**
 * Formats byte values into human-readable strings (e.g. "86.4 MB", "1.42 MB", "42.5 MB").
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) return "0 B";
  if (bytes < 1) return `${Math.round(bytes)} B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  let val = bytes / Math.pow(1024, i);
  if (Math.round(val) >= 1024 && i < units.length - 1) {
    i++;
    val /= 1024;
  }
  const formatted =
    i === 0
      ? val.toFixed(0)
      : val < 10
        ? val.toFixed(2)
        : val < 100
          ? val.toFixed(1)
          : val.toFixed(0);
  return `${formatted} ${units[i]}`;
}

export default systemPaths;

