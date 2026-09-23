import { defineConfig } from "vitest/config";
import { applyTestCacheEnv, ensureTestCacheRoot, testCacheEnv } from "./tests/helpers/test-cache.js";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/** `NANOS_LIVE_TESTS=0` selects the hermetic offline subset (see AGENTS.md). */
const liveTestsEnabled = !DISABLED_VALUES.has(
  (process.env.NANOS_LIVE_TESTS ?? "").trim().toLowerCase()
);

// Per-run isolated cache root, applied here and inherited by every worker.
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
      // Enforced for complete runs only: the offline subset cannot meet them.
      thresholds: liveTestsEnabled
        ? {
            autoUpdate: false,
            lines: 85,
            functions: 88,
            branches: 75,
            statements: 85,
            // Floor for the riskiest module, with margin for the CI matrix.
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
