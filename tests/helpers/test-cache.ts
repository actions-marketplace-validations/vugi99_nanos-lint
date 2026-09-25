import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Isolated cache root of the run; set by `vitest.config.ts`. */
export const TEST_CACHE_ROOT_ENV = "NANOS_TEST_CACHE_ROOT";

/** `"1"` when the config created the root itself; only then is it deleted. */
export const TEST_CACHE_EPHEMERAL_ENV = "NANOS_TEST_CACHE_EPHEMERAL";

/** Relocates the cache and temp paths `env-paths`/`os.tmpdir()` resolve. */
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

/** Cache root of this run, created once and reused by later calls. */
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
      `[test-cache] Failed to remove isolated cache root ${root}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
