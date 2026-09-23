import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { logger } from "../logger.js";

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
