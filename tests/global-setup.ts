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
 * Vitest global setup.
 *
 * Runs once in the Vitest main process, before any worker starts, and:
 *
 * 1. Relocates every platform cache/temp directory into a per-run isolated
 *    root, so tests can never read or write the developer's real
 *    `~/.cache/nanos-lint` (and no user cache can mask a bug).
 * 2. Downloads the shared LuaLS binary (and the nanos world annotations file)
 *    exactly once into that root. Every worker then sees a warm cache, so the
 *    run performs a single download instead of one per test file.
 *
 * With `NANOS_LIVE_TESTS=0` no network access happens at all and the live test
 * suites are skipped.
 */
export default async function setup(project?: { config?: { watch?: boolean } }) {
  const { root, ephemeral } = ensureTestCacheRoot();
  applyTestCacheEnv(process.env, root);
  // Start every run from an empty download log, so a reused cache root never
  // reports downloads performed by an earlier run.
  resetLuaLSDownloadLog(root);
  installLuaLSDownloadCounter(root);

  // Imported dynamically so `src/paths.ts` resolves its cache paths *after* the
  // isolated environment is in place (static imports would be hoisted).
  const { isLiveTestsEnabled } = await import("./helpers/live.js");

  const isWatchMode = project?.config?.watch === true;
  const teardown = async () => {
    // `tests/helpers/download-counter-setup.ts` records every real LuaLS archive
    // download of every worker into the same log. More than one download for a
    // single run means a test bypassed the shared cache and has to be fixed.
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

    // Always clean up before reporting the failure, so a failed run does not
    // leave its temporary cache root behind.
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
    // One resolution for the entire run: the binary is downloaded into the
    // isolated cache here (if it is not already present) and every worker
    // afterwards hits the weekly metadata fast path.
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
