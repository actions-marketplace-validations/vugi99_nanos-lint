import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../logger.js";
import { DEFAULT_LUALS_VERSION, resolveLuaLSVersion } from "./version.js";
import { getPlatformInfo } from "./platform.js";
import { findExistingLuaLSDir, getBaseLuaLSCacheDir, getCacheDir } from "./cache.js";

const execFileAsync = promisify(execFile);

/**
 * Escapes single quotes for safe PowerShell single-quoted string interpolation.
 */
export function escapePowerShellSingleQuote(str: string): string {
  return str.replace(/'/g, "''");
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

export interface DownloadOptions {
  quiet?: boolean;
  reuseExisting?: boolean;
  /** Base directory searched for an installed copy when reusing. Defaults to the system cache. */
  cacheDir?: string;
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

