import fs from "node:fs";
import path from "node:path";
import { systemPaths } from "./paths.js";
import { logger } from "./logger.js";
import { writeAtomicFileSync } from "./lock.js";

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
export const MIN_ANNOTATIONS_SIZE_BYTES = 1000;
export const MAX_ANNOTATIONS_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_COMMIT_JSON_SIZE_BYTES = 1024 * 1024;

/** Returns current date string formatted as YYYY-MM-DD alongside a date components object. */
export function getTodayDateString(d: Date = new Date()): {
  dateStr: string;
  dateObj: AnnotationsDate;
} {
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { dateStr, dateObj: { year, month, day } };
}

/** Returns the system cache directory used for nanos world annotations. */
export function getAnnotationsCacheDir(): string {
  return path.join(systemPaths.cache, "annotations");
}

/** Returns the full path to the cached annotations.lua file. */
export function getCachedAnnotationsFilePath(): string {
  return path.join(getAnnotationsCacheDir(), ANNOTATIONS_FILENAME);
}

/** Returns the full path to the annotations metadata.json file. */
export function getAnnotationsMetadataFilePath(): string {
  return path.join(getAnnotationsCacheDir(), METADATA_FILENAME);
}

/** Reads and parses annotations metadata.json, purging corrupt files automatically. */
export function readAnnotationsMetadata(
  cacheDir: string = getAnnotationsCacheDir(),
): AnnotationsMetadata | null {
  const metaPath = path.join(cacheDir, "metadata.json");
  if (!fs.existsSync(metaPath)) return null;

  const purge = (reason: string) => {
    try {
      fs.unlinkSync(metaPath);
      logger.warn(`[annotations] ${reason} annotations metadata at ${metaPath} purged.`);
    } catch (err) {
      logger.debug(
        `[annotations] Failed to unlink metadata: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as AnnotationsMetadata;
    if (typeof parsed?.commitId === "string" && typeof parsed?.lastChecked === "string") {
      return parsed;
    }
    purge("Stale or invalid");
  } catch (err) {
    logger.debug(
      `Failed to parse annotations metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
    purge("Corrupted");
  }
  return null;
}

/** Verifies that an annotations file exists, is non-trivial in size, and contains valid header. */
export function isAnnotationsValid(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < MIN_ANNOTATIONS_SIZE_BYTES) return false;
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
      `[annotations] Annotation validation failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Updates metadata lastChecked date atomically without modifying annotations.lua. */
export function updateLastCheckedDate(
  commitId: string,
  cacheDir: string = getAnnotationsCacheDir(),
): AnnotationsMetadata {
  const { dateStr, dateObj } = getTodayDateString();
  const metadata: AnnotationsMetadata = { commitId, lastChecked: dateStr, date: dateObj };
  fs.mkdirSync(cacheDir, { recursive: true });
  const metaPath = path.join(cacheDir, METADATA_FILENAME);
  // Atomic replacement (#7): concurrent readers always parse a complete file.
  writeAtomicFileSync(metaPath, JSON.stringify(metadata, null, 2));
  return metadata;
}
