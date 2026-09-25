import fs from "node:fs";
import path from "node:path";
import { systemPaths, getDirectorySize, formatBytes } from "./paths.js";
import { readLuaLSMetadata, listCachedLuaLSVersionDirs, getCacheDir } from "./luals/cache.js";
import { getPlatformInfo } from "./luals/platform.js";
import { isBinaryValid } from "./luals/validation.js";
import { readAnnotationsMetadata, isAnnotationsValid } from "./annotations.js";

export interface CachedLuaLSVersionInfo {
  version: string;
  status: "valid" | "corrupted";
  size: number;
  sizeFormatted: string;
  path: string;
}

export interface LuaLSCacheStatus {
  weeklyCheck: string | null;
  lastCheckedDate: string | null;
  targetVersion: string | null;
  versions: CachedLuaLSVersionInfo[];
}

export interface AnnotationsCacheStatus {
  status: "valid" | "corrupted" | "missing";
  size: number;
  sizeFormatted: string;
  path: string;
  commitId: string | null;
  lastChecked: string | null;
}

export interface CacheStatusReport {
  cacheDirectory: string;
  totalSize: number;
  totalSizeFormatted: string;
  luals: LuaLSCacheStatus;
  annotations: AnnotationsCacheStatus;
}

/** Collects detailed status and disk usage information for LuaLS and annotations caches. */
export function getCacheStatus(baseCacheDir: string = systemPaths.cache): CacheStatusReport {
  const totalSize = getDirectorySize(baseCacheDir);
  const totalSizeFormatted = formatBytes(totalSize);

  // 1. LuaLS Inspection
  const lualsBaseDir = path.join(baseCacheDir, "luals");
  const lualsMeta = readLuaLSMetadata(lualsBaseDir);
  const candidateVersions = listCachedLuaLSVersionDirs(lualsBaseDir);

  const versionInfos: CachedLuaLSVersionInfo[] = [];

  for (const ver of candidateVersions) {
    const versionDir = getCacheDir(ver, lualsBaseDir);
    const marker = path.join(versionDir, ".complete");
    const info = getPlatformInfo(ver);
    const binPath = path.join(versionDir, info.binaryRelativePath);
    let isValid = false;
    if (fs.existsSync(marker) && fs.existsSync(binPath)) {
      try {
        isValid = fs.readFileSync(marker, "utf-8").trim() === ver && isBinaryValid(binPath);
      } catch {
        isValid = false;
      }
    }
    const dirSize = getDirectorySize(versionDir);

    versionInfos.push({
      version: ver,
      status: isValid ? "valid" : "corrupted",
      size: dirSize,
      sizeFormatted: formatBytes(dirSize),
      path: versionDir,
    });
  }

  const lualsStatus: LuaLSCacheStatus = {
    weeklyCheck: lualsMeta?.lastCheckedWeek ?? null,
    lastCheckedDate: lualsMeta?.lastCheckedDate ?? null,
    targetVersion: lualsMeta?.latestVersion ?? null,
    versions: versionInfos,
  };

  // 2. Annotations Inspection
  const annotationsDir = path.join(baseCacheDir, "annotations");
  const annotationsFile = path.join(annotationsDir, "annotations.lua");
  const annMeta = readAnnotationsMetadata(annotationsDir);

  let annStatus: "valid" | "corrupted" | "missing" = "missing";
  let annSize = 0;

  if (fs.existsSync(annotationsFile)) {
    annSize = getDirectorySize(annotationsFile);
    annStatus = isAnnotationsValid(annotationsFile) ? "valid" : "corrupted";
  }

  const annotationsStatus: AnnotationsCacheStatus = {
    status: annStatus,
    size: annSize,
    sizeFormatted: formatBytes(annSize),
    path: annotationsFile,
    commitId: annMeta?.commitId ?? null,
    lastChecked: annMeta?.lastChecked ?? null,
  };

  return {
    cacheDirectory: baseCacheDir,
    totalSize,
    totalSizeFormatted,
    luals: lualsStatus,
    annotations: annotationsStatus,
  };
}

/** Formats a cache status report into human-readable terminal output. */
export function formatCacheStatusPretty(report: CacheStatusReport): string {
  const lines: string[] = [];

  lines.push("nanos-lint Cache Status");
  lines.push("");
  lines.push(`Cache Directory:   ${report.cacheDirectory}`);
  lines.push(`Total Disk Usage:  ${report.totalSizeFormatted}`);
  lines.push("");
  lines.push("Lua Language Server (LuaLS):");

  const weeklyStr = report.luals.weeklyCheck
    ? `${report.luals.weeklyCheck}${report.luals.lastCheckedDate ? ` (last checked: ${report.luals.lastCheckedDate})` : ""}`
    : "none";
  lines.push(`  - Weekly Check:   ${weeklyStr}`);

  const targetVer = report.luals.targetVersion ?? "none";
  lines.push(`  - Target Version: ${targetVer}`);

  if (report.luals.versions.length === 0) {
    lines.push("  - Cached Copies:  none");
  } else {
    lines.push("  - Cached Copies:");
    for (const v of report.luals.versions) {
      lines.push(`      * ${v.version} (status: ${v.status}, size: ${v.sizeFormatted})`);
    }
  }

  lines.push("");
  lines.push("nanos world Annotations:");

  if (report.annotations.status === "missing") {
    lines.push("  - Status:         Not cached");
  } else {
    const statusCap = report.annotations.status === "valid" ? "Valid" : "Corrupted";
    lines.push(`  - Status:         ${statusCap} (${report.annotations.sizeFormatted})`);
    if (report.annotations.commitId) {
      const sha = report.annotations.commitId;
      const shaDisplay =
        sha.length >= 7 && sha !== "unknown" ? `${sha.slice(0, 8)} (docgen-output)` : sha;
      lines.push(`  - Commit SHA:     ${shaDisplay}`);
    }
    if (report.annotations.lastChecked) {
      lines.push(`  - Last Checked:   ${report.annotations.lastChecked}`);
    }
  }

  return lines.join("\n");
}
