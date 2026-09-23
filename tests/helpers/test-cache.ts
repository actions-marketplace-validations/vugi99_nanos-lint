import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-run isolated cache used by the whole Vitest run.
 *
 * `vitest.config.ts` creates the directory (unless the developer supplied
 * `NANOS_TEST_CACHE_ROOT` to reuse a warm one) and every worker inherits the
 * environment variables that relocate the platform cache directories, so no
 * test can ever read or write the developer's real `~/.cache/nanos-lint`.
 */
export const TEST_CACHE_ROOT_ENV = "NANOS_TEST_CACHE_ROOT";

/**
 * Set by `vitest.config.ts` when it created the cache root itself. Only such
 * roots are deleted again after the run; a user supplied root is never touched.
 */
export const TEST_CACHE_EPHEMERAL_ENV = "NANOS_TEST_CACHE_EPHEMERAL";

/**
 * Environment variables that relocate every cache path `env-paths` resolves:
 * `XDG_CACHE_HOME` on Linux, `HOME` on macOS, `LOCALAPPDATA`/`APPDATA` on
 * Windows. `TMPDIR`/`TEMP`/`TMP` are relocated as well so temporary artifacts
 * (LuaLS check output, annotation staging) stay inside the run directory.
 */
export function testCacheEnv(root: string): Record<string, string> {
  const tmp = path.join(root, "tmp");
  if (process.platform === "win32") {
    return {
      LOCALAPPDATA: path.join(root, "localappdata"),
      APPDATA: path.join(root, "appdata"),
      TEMP: tmp,
      TMP: tmp,
    };
  }
  if (process.platform === "darwin") {
    return {
      HOME: path.join(root, "home"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      TMPDIR: tmp,
    };
  }
  return {
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    TMPDIR: tmp,
  };
}

export function applyTestCacheEnv(target: NodeJS.ProcessEnv, root: string): void {
  fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
  for (const [key, value] of Object.entries(testCacheEnv(root))) {
    fs.mkdirSync(value, { recursive: true });
    target[key] = value;
  }
}

/**
 * Returns the cache root of this run, creating a fresh ephemeral one when
 * `NANOS_TEST_CACHE_ROOT` is not set. Idempotent: repeated calls (config
 * reloads in watch mode) reuse the value already stored in the environment.
 */
export function ensureTestCacheRoot(): { root: string; ephemeral: boolean } {
  const existing = process.env[TEST_CACHE_ROOT_ENV];
  if (existing) {
    return { root: existing, ephemeral: process.env[TEST_CACHE_EPHEMERAL_ENV] === "1" };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-lint-tests-"));
  process.env[TEST_CACHE_ROOT_ENV] = root;
  process.env[TEST_CACHE_EPHEMERAL_ENV] = "1";
  return { root, ephemeral: true };
}

export function removeTestCacheRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.warn(
      `[test-cache] Failed to remove isolated cache root ${root}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
