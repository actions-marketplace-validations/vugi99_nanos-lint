import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node24",
  shims: true,
  fixedExtension: false,
  alias: {
    "jsonc-parser": "jsonc-parser/lib/esm/main.js",
  },
  deps: {
    // "nanos-lint" produces a standalone distribution with zero runtime dependencies.
    // "is-safe-filename" is an internal transitive runtime dependency of "env-paths@4.0.0".
    // When using "onlyBundle", tsdown / Rolldown requires transitive sub-dependencies
    // to be explicitly declared so they are inlined into the bundle rather than left
    // as external module imports.
    alwaysBundle: ["commander", "jsonc-parser", "env-paths", "is-safe-filename"],
    onlyBundle: ["commander", "jsonc-parser", "env-paths", "is-safe-filename"],
  },
});

