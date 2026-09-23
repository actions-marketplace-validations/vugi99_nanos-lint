import { installLuaLSDownloadCounter } from "./download-counter.js";
import { TEST_CACHE_ROOT_ENV } from "./test-cache.js";

/** Vitest `setupFiles` entry: installs the download counter in every worker. */
const cacheRoot = process.env[TEST_CACHE_ROOT_ENV];
if (cacheRoot) {
  installLuaLSDownloadCounter(cacheRoot);
}
