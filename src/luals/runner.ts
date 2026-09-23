import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../logger.js";
import { getPackageRoot } from "../config.js";
import { systemPaths } from "../paths.js";
import { fileUriToPath } from "../types.js";
import type { CheckOptions, CheckResult, DiagnosticReport, LuaRCConfig } from "../types.js";
import { LuaLSError } from "../errors.js";
import {
  DEFAULT_LUALS_VERSION,
  FALLBACK_LUALS_VERSION,
  resolveLuaLSVersion,
  fetchLatestLuaLSVersionFromGitHub,
} from "./version.js";
import { getPlatformInfo } from "./platform.js";
import {
  getBaseLuaLSCacheDir,
  getCacheDir,
  getLegacyCacheDir,
  readLuaLSMetadata,
  writeLuaLSMetadata,
  listCachedLuaLSVersions,
  cleanupOldCachedLuaLSVersions,
  getIsoWeek,
} from "./cache.js";
import { isBinaryValid, downloadAndExtractLuaLS } from "./download.js";

const execFileAsync = promisify(execFile);

export interface ResolveLuaLSOptions {
  quiet?: boolean;
  /** Cache base directory (version directories, metadata, temp extraction). Defaults to the system cache. */
  cacheDir?: string;
  /** Set to `false` to always fetch the archive instead of reusing an installed copy. */
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

    let wasCorrupted = false;
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
      wasCorrupted = true;
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
    if (options?.reuseExisting !== false) {
      const legacyDir = getLegacyCacheDir(resolvedVersion);
      if (path.resolve(legacyDir) !== path.resolve(cachedDir)) {
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
            return legacyPath;
          }
        }
      }
    }

    // In PATH
    if (options?.reuseExisting !== false) {
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

    // Download and cache explicit version
    try {
      return await downloadAndExtractLuaLS(
        resolvedVersion,
        getCacheDir(resolvedVersion, baseCacheDir),
        options
      );
    } catch (err) {
      if (wasCorrupted) {
        throw new LuaLSError(
          `Cached LuaLS binary at '${cachedPath}' is corrupted (failed execution/size check) and cannot be re-downloaded while offline. Please connect to the internet to repair or run 'nanos-lint clean-cache'.`,
          "ERR_LUALS_CORRUPTED_CACHE",
          "Connect to the internet to repair the corrupted binary or run 'nanos-lint clean-cache'.",
          { cause: err }
        );
      }
      throw err;
    }
  }

  // 3. Default/latest version: Weekly cache check & auto-cleanup
  const currentWeek = getIsoWeek();
  const metadata = readLuaLSMetadata(baseCacheDir);

  // Fast path first: enumerating the cache would spawn every cached binary.
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

  const cachedVersions = listCachedLuaLSVersions(baseCacheDir);

  // Same week, but the recorded version is unusable: reuse another cached one.
  const firstCachedVersion = cachedVersions[0];
  if (metadata && metadata.lastCheckedWeek === currentWeek && firstCachedVersion) {
    const info = getPlatformInfo(firstCachedVersion);
    return path.join(getCacheDir(firstCachedVersion, baseCacheDir), info.binaryRelativePath);
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
  } else if (firstCachedVersion) {
    logger.info(`[luals] Network unreachable or rate limited; using cached LuaLS ${firstCachedVersion}.`);
    targetVersion = firstCachedVersion;
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
  let wasCorrupted = false;
  if (fs.existsSync(targetBinaryPath)) {
    if (fs.existsSync(completeMarker) && isBinaryValid(targetBinaryPath)) {
      // Already downloaded and valid; clean up any older versions
      cleanupOldCachedLuaLSVersions(targetVersion, baseCacheDir);
      return targetBinaryPath;
    }
    wasCorrupted = true;
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
  let downloadedBinary: string;
  try {
    downloadedBinary = await downloadAndExtractLuaLS(targetVersion, targetCacheDir, options);
  } catch (err) {
    if (wasCorrupted) {
      throw new LuaLSError(
        `Cached LuaLS binary at '${targetBinaryPath}' is corrupted (failed execution/size check) and cannot be re-downloaded while offline. Please connect to the internet to repair or run 'nanos-lint clean-cache'.`,
        "ERR_LUALS_CORRUPTED_CACHE",
        "Connect to the internet to repair the corrupted binary or run 'nanos-lint clean-cache'.",
        { cause: err }
      );
    }
    throw err;
  }

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
    throw new LuaLSError(
      `Target path does not exist: ${targetPath}`,
      "ERR_TARGET_NOT_FOUND",
      "Verify that the target path exists and is accessible."
    );
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
      throw new LuaLSError(
        `LuaLS check failed to execute or produce diagnostic output: ${execError instanceof Error ? execError.message : String(execError)}. ${cacheHint}`,
        "ERR_LUALS_EXECUTION",
        "Inspect the debug log with --log-level=debug or run 'nanos-lint clean-cache' to re-fetch LuaLS.",
        { cause: execError }
      );
    }
    throw new LuaLSError(
      `LuaLS check failed to produce diagnostic output at: ${checkOutPath}. ${cacheHint}`,
      "ERR_LUALS_NO_OUTPUT",
      "Ensure the temporary directory is writable and sufficient disk space is available."
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

