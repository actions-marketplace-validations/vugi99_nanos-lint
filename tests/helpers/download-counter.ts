import fs from "node:fs";
import path from "node:path";

/**
 * Records every real LuaLS archive download of a run, so the global setup can
 * fail the run when the shared binary is fetched more than once. Mocked `fetch`
 * implementations never touch the network and therefore bypass the counter.
 */
export const LUALS_DOWNLOAD_LOG_FILENAME = "luals-downloads.log";

interface CounterMarkedFetch {
  __nanosLuaLSDownloadCounter?: boolean;
}

function isLuaLSArchiveUrl(url: string): boolean {
  return url.includes("lua-language-server/releases/download/");
}

/** Installs the counter on `globalThis.fetch` (idempotent). */
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

/** Clears the log so a reused cache root does not report earlier runs. */
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
