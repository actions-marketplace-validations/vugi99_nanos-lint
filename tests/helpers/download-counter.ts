import fs from "node:fs";
import path from "node:path";

/**
 * Test-harness guard that records every real LuaLS archive download performed
 * during a test run.
 *
 * The suite is required to download the shared LuaLS binary exactly once per
 * run (in `tests/global-setup.ts`, before any worker starts) and to reuse that
 * copy everywhere else. The counter wraps `globalThis.fetch` in the global
 * setup process and in every worker (`setupFiles`), appending a line per real
 * `releases/download/...lua-language-server...` request to a log inside the
 * isolated cache root; the global setup teardown then fails the run when more
 * than one download happened.
 *
 * Mocked `fetch` implementations installed by individual tests intentionally
 * bypass the counter: they never touch the network, so they cannot be part of a
 * duplicate-download regression.
 */
export const LUALS_DOWNLOAD_LOG_FILENAME = "luals-downloads.log";

interface CounterMarkedFetch {
  __nanosLuaLSDownloadCounter?: boolean;
}

function isLuaLSArchiveUrl(url: string): boolean {
  return url.includes("lua-language-server/releases/download/");
}

/**
 * Installs the download counter on `globalThis.fetch`. Idempotent, and it never
 * replaces a `fetch` that a test has already replaced.
 */
export function installLuaLSDownloadCounter(cacheRoot: string): void {
  const currentFetch = globalThis.fetch as typeof fetch & CounterMarkedFetch;
  if (currentFetch.__nanosLuaLSDownloadCounter) {
    return;
  }

  const logPath = path.join(cacheRoot, LUALS_DOWNLOAD_LOG_FILENAME);
  const originalFetch = currentFetch;

  const countingFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isLuaLSArchiveUrl(url)) {
      try {
        fs.appendFileSync(logPath, `${process.pid} ${url}\n`, "utf-8");
      } catch (err) {
        // Instrumentation must never break a test run.
        process.stderr.write(
          `[tests] Failed to record LuaLS download: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
    return originalFetch(input, init);
  };

  (countingFetch as typeof fetch & CounterMarkedFetch).__nanosLuaLSDownloadCounter = true;
  globalThis.fetch = countingFetch as typeof fetch;
}

/**
 * Clears the download log. Called once by the global setup at the start of a
 * run, so a reused (`NANOS_TEST_CACHE_ROOT`) directory never reports downloads
 * from an earlier run.
 */
export function resetLuaLSDownloadLog(cacheRoot: string): void {
  const logPath = path.join(cacheRoot, LUALS_DOWNLOAD_LOG_FILENAME);
  fs.rmSync(logPath, { force: true });
}

/** Number of LuaLS archive downloads recorded so far for this run. */
export function countLuaLSDownloads(cacheRoot: string): number {
  return readLuaLSDownloadLog(cacheRoot).length;
}

/** Recorded `"<pid> <url>"` lines, one per LuaLS archive download. */
export function readLuaLSDownloadLog(cacheRoot: string): string[] {
  const logPath = path.join(cacheRoot, LUALS_DOWNLOAD_LOG_FILENAME);
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}
