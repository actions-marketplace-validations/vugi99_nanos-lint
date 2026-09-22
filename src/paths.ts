import fs from "node:fs";
import envPaths from "env-paths";

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

export default systemPaths;

