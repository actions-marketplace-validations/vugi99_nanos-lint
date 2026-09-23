import {
  applyTestCacheEnv,
  ensureTestCacheRoot,
  removeTestCacheRoot,
} from "./helpers/test-cache.js";
import {
  countLuaLSDownloads,
  installLuaLSDownloadCounter,
  readLuaLSDownloadLog,
  resetLuaLSDownloadLog,
} from "./helpers/download-counter.js";

/**
 * Vitest global setup: isolates the cache/temp directories for the run and
 * downloads the shared LuaLS binary and annotations once, before any worker
 * starts. `NANOS_LIVE_TESTS=0` skips all of it.
 */
export default async function setup(project?: { config?: { watch?: boolean } }) {
  const { root, ephemeral } = ensureTestCacheRoot();
  applyTestCacheEnv(process.env, root);
  resetLuaLSDownloadLog(root);
  installLuaLSDownloadCounter(root);

  // Dynamic import: `src/paths.ts` must resolve after the isolated env is set.
  const { isLiveTestsEnabled } = await import("./helpers/live.js");

  const isWatchMode = project?.config?.watch === true;
  const teardown = async () => {
    // One shared download per run is allowed; a second one is a bug.
    const downloads = countLuaLSDownloads(root);
    console.log(
      `[tests] LuaLS archive downloads during this run: ${downloads} (at most 1 is allowed).`
    );

    let downloadError: Error | null = null;
    if (downloads > 1) {
      downloadError = new Error(
        `The test run downloaded the LuaLS archive ${downloads} times; ` +
          `exactly one shared download is allowed (see tests/global-setup.ts and tests/helpers/live.ts).\n` +
          readLuaLSDownloadLog(root)
            .map((line) => `  - ${line}`)
            .join("\n")
      );
    }

    // Clean up before throwing, so a failed run leaves nothing behind.
    if (ephemeral && !isWatchMode) {
      removeTestCacheRoot(root);
    }

    if (downloadError) {
      throw downloadError;
    }
  };

  if (!isLiveTestsEnabled()) {
    console.warn(
      "\n[tests] NANOS_LIVE_TESTS is disabled: skipping live LuaLS/annotations tests, " +
        "no network access will be performed, and coverage thresholds are not enforced.\n"
    );
    return teardown;
  }

  const { resolveLuaLSBinary } = await import("../src/luals.js");
  const { resolveAnnotations } = await import("../src/annotations.js");

  try {
    // Downloaded here (once) if not already cached; workers then hit the cache.
    const binary = await resolveLuaLSBinary(undefined, { quiet: true });
    const annotations = await resolveAnnotations({ quiet: true });
    console.log(
      `[tests] Shared live-test fixtures ready (at most one LuaLS download for this run).\n` +
        `[tests]   cache root:  ${root}\n` +
        `[tests]   LuaLS:       ${binary}\n` +
        `[tests]   annotations: ${annotations}`
    );
  } catch (err) {
    if (ephemeral && !isWatchMode) {
      removeTestCacheRoot(root);
    }
    throw new Error(
      `Failed to prepare the shared live-test fixtures (LuaLS binary and annotations). ` +
        `Run the suite offline with NANOS_LIVE_TESTS=0 to skip the live tests. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  return teardown;
}
