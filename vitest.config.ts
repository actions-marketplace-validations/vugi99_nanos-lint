import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        autoUpdate: false,
        lines: 85,
        functions: 88,
        branches: 75,
        statements: 85,
      },
    },
  },
});

