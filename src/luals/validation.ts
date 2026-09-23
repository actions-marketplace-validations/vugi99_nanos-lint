import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { logger } from "../logger.js";
import { LuaLSError } from "../errors.js";

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

/**
 * Validates an explicitly configured LuaLS binary (`LUALS_BIN` environment
 * variable or `--luals-bin` CLI option) and returns its path.
 *
 * Both are documented escape hatches, so a typo, a stale path, a directory or
 * an unrelated executable must fail with an actionable error instead of a
 * confusing low-level failure deep inside the check run (#26).
 *
 * @param binaryPath Path exactly as the user supplied it.
 * @param source Name of the setting being validated (`LUALS_BIN` / `--luals-bin`).
 */
export function assertValidLuaLSBinary(binaryPath: string, source: string): string {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(binaryPath);
  } catch (err) {
    throw new LuaLSError(
      `${source} points to '${binaryPath}', which does not exist or cannot be read: ${err instanceof Error ? err.message : String(err)}`,
      "ERR_LUALS_BIN_INVALID",
      `Set ${source} to the full path of a lua-language-server executable, or leave it unset so nanos-lint resolves LuaLS automatically.`,
      { cause: err }
    );
  }

  if (!stats.isFile()) {
    throw new LuaLSError(
      `${source} points to '${binaryPath}', which is not a regular file (a directory or special file was found).`,
      "ERR_LUALS_BIN_INVALID",
      `Point ${source} at the lua-language-server executable itself, or leave it unset so nanos-lint resolves LuaLS automatically.`
    );
  }

  if (!isBinaryValid(binaryPath)) {
    throw new LuaLSError(
      `${source} points to '${binaryPath}', which is not a runnable LuaLS binary (executing it with '--version' failed or reported no version).`,
      "ERR_LUALS_BIN_INVALID",
      `Verify ${source} points at a working lua-language-server executable, or leave it unset so nanos-lint resolves LuaLS automatically.`
    );
  }

  return binaryPath;
}

