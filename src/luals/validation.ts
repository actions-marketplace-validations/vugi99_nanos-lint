import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { logger } from "../logger.js";
import { LuaLSError } from "../errors.js";

/**
 * Minimum plausible size of a downloaded LuaLS executable. Release assets are
 * several megabytes, so anything smaller is a truncated download or a stray
 * file. This floor only applies to binaries nanos-lint fetched itself: a
 * user-supplied `LUALS_BIN` may legitimately be a small wrapper script.
 */
export const MIN_DOWNLOADED_BINARY_SIZE_BYTES = 100_000;

/**
 * Runs `binaryPath --version` and checks that it reports a LuaLS version.
 * Shared by every binary validation path; the size heuristic stays separate
 * because only downloaded archives have a known-plausible size.
 */
function reportsLuaLSVersion(binaryPath: string): boolean {
  try {
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
 * Verifies that a downloaded or cached LuaLS binary exists, has non-trivial
 * size, and is executable.
 */
export function isBinaryValid(binaryPath: string): boolean {
  if (!fs.existsSync(binaryPath)) {
    return false;
  }
  try {
    const stats = fs.statSync(binaryPath);
    if (!stats.isFile() || stats.size < MIN_DOWNLOADED_BINARY_SIZE_BYTES) {
      return false;
    }
    return reportsLuaLSVersion(binaryPath);
  } catch (err) {
    logger.debug(
      `[luals] Binary validation check failed for ${binaryPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * Verifies that an explicitly configured binary is a regular file that runs and
 * reports a LuaLS version, without the downloaded-archive size heuristic so
 * wrapper scripts (`LUALS_BIN=/usr/local/bin/lua-language-server`) keep working.
 */
export function isBinaryRunnable(binaryPath: string): boolean {
  try {
    if (!fs.statSync(binaryPath).isFile()) {
      return false;
    }
  } catch (err) {
    logger.debug(
      `[luals] Binary validation check failed for ${binaryPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
  return reportsLuaLSVersion(binaryPath);
}

/**
 * Validates an explicitly configured LuaLS binary (`LUALS_BIN` environment
 * variable or `--luals-bin` CLI option) and returns its path.
 *
 * Both are documented escape hatches, so a typo, a stale path, a directory or an
 * unrelated executable must fail with an actionable error instead of a
 * confusing low-level failure deep inside the check run (#26). Executables are
 * accepted as-is when `--version` reports a version, including the thin wrapper
 * scripts that Homebrew/mason-style installations put on `PATH`: the size floor
 * used for downloaded archives would reject those.
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

  if (!isBinaryRunnable(binaryPath)) {
    throw new LuaLSError(
      `${source} points to '${binaryPath}', which is not a runnable LuaLS binary (running it with '--version' failed or printed no version).`,
      "ERR_LUALS_BIN_INVALID",
      `Verify ${source} points at a working lua-language-server executable or wrapper script, or leave it unset so nanos-lint resolves LuaLS automatically.`
    );
  }

  return binaryPath;
}

