import { defineConfig } from "vitest/config";
import { applyTestCacheEnv, ensureTestCacheRoot, testCacheEnv } from "./tests/helpers/test-cache.js";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Live tests execute the real LuaLS binary and resolve the real annotations
 * file. They are enabled by default; `NANOS_LIVE_TESTS=0` runs the hermetic
 * offline subset instead (see `AGENTS.md`, "Offline Test Mode").
 */
const liveTestsEnabled = !DISABLED_VALUES.has(
  (process.env.NANOS_LIVE_TESTS ?? "").trim().toLowerCase()
);

// Isolated, per-run cache root. The environment variables are inherited by every
// worker *and* applied to this process before globalSetup imports `src/`.
const { root: testCacheRoot } = ensureTestCacheRoot();
applyTestCacheEnv(process.env, testCacheRoot);

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/helpers/download-counter-setup.ts"],
    env: {
      NANOS_TEST_CACHE_ROOT: testCacheRoot,
      NANOS_TEST_CACHE_EPHEMERAL: process.env.NANOS_TEST_CACHE_EPHEMERAL ?? "0",
      ...testCacheEnv(testCacheRoot),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      // The live LuaLS tests carry a large part of the coverage of `src/luals.ts`
      // and `src/cli.ts`; when they are skipped the offline subset cannot meet
      // the thresholds, so they are only enforced for a complete run.
      thresholds: liveTestsEnabled
        ? {
            autoUpdate: false,
            lines: 85,
            functions: 88,
            branches: 75,
            statements: 85,
            // Per-file floor for the riskiest module: a large regression in the
            // download/caching logic must not be masked by the 100%-covered
            // helper modules, while the margin keeps the check stable across the
            // CI platform matrix.
            "src/luals.ts": {
              lines: 78,
              functions: 85,
              branches: 65,
              statements: 78,
            },
          }
        : undefined,
    },
  },
});
