import fs from "node:fs";
import path from "node:path";
import { resolveLuaLSBinary, getPlatformInfo } from "../../src/luals.js";
import { resolveAnnotations } from "../../src/annotations.js";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Live tests execute the real LuaLS binary and (through the CLI) resolve the
 * real annotations file. They run by default and are skipped only when
 * `NANOS_LIVE_TESTS` is explicitly set to a falsy value.
 */
export function isLiveTestsEnabled(): boolean {
  const raw = (process.env.NANOS_LIVE_TESTS ?? "").trim().toLowerCase();
  return !DISABLED_VALUES.has(raw);
}

let sharedBinaryPromise: Promise<string> | null = null;

/**
 * Resolves the LuaLS binary shared by the whole test run.
 *
 * `tests/global-setup.ts` downloads it exactly once into the isolated test
 * cache before any worker starts, so this call is a cache hit in practice.
 * Within a worker the promise is memoized, so concurrent tests await the same
 * resolution instead of racing into separate downloads.
 */
export function getSharedLuaLSBinary(): Promise<string> {
  sharedBinaryPromise ??= resolveLuaLSBinary(undefined, { quiet: true });
  return sharedBinaryPromise;
}

let sharedAnnotationsPromise: Promise<string> | null = null;

/** Resolves (and caches) the annotations file once per worker process. */
export function getSharedAnnotations(): Promise<string> {
  sharedAnnotationsPromise ??= resolveAnnotations({ quiet: true });
  return sharedAnnotationsPromise;
}

/**
 * Copies the shared LuaLS installation into `baseCacheDir/<version>` and marks
 * it complete, so tests can exercise cache-specific behaviour with a real,
 * functional binary without mutating any shared directory.
 *
 * @returns the path of the seeded binary.
 */
export async function seedCachedLuaLS(baseCacheDir: string, version: string): Promise<string> {
  const info = getPlatformInfo(version);
  const binary = await getSharedLuaLSBinary();
  // <version>/<binaryRelativePath> -> the version directory the cache expects.
  const parentHops = info.binaryRelativePath.split(path.sep).length;
  const sourceDir = path.resolve(binary, ...Array(parentHops).fill(".."));
  const targetDir = path.join(baseCacheDir, version);

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, ".complete"), version, "utf-8");

  return path.join(targetDir, info.binaryRelativePath);
}
