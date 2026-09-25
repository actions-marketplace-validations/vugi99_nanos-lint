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
    // "glob" powers the glob matching in "countCheckedFiles()" (#27). Its own dependency
    // tree ("minimatch", "path-scurry", "lru-cache", "minipass" and "brace-expansion") is
    // inlined automatically while bundling "glob", but the packages stay listed here so a
    // future direct import cannot silently become an external runtime dependency.
    // "onlyBundle" is the whitelist of dependencies allowed to be bundled: it only needs
    // the packages imported by the entry graph, because listing the already-inlined
    // transitive dependencies makes tsdown report them as unused.
    alwaysBundle: [
      "commander",
      "jsonc-parser",
      "env-paths",
      "is-safe-filename",
      "glob",
      "minimatch",
      "path-scurry",
      "lru-cache",
      "minipass",
      "brace-expansion",
    ],
    onlyBundle: ["commander", "jsonc-parser", "env-paths", "is-safe-filename", "glob"],
  },
});
