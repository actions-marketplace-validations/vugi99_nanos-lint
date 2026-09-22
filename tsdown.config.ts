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
  deps: {
    alwaysBundle: ["commander"],
    onlyBundle: ["commander"],
  },
});

