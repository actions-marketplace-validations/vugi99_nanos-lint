import { installLuaLSDownloadCounter } from "./download-counter.js";
import { TEST_CACHE_ROOT_ENV } from "./test-cache.js";

/**
 * Vitest `setupFiles` entry: runs in every worker before the test file is
 * imported, and installs the LuaLS download counter so the whole run can be
 * checked for duplicate downloads.
 */
const cacheRoot = process.env[TEST_CACHE_ROOT_ENV];
if (cacheRoot) {
  installLuaLSDownloadCounter(cacheRoot);
}
