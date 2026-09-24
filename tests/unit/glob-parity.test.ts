import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { countCheckedFiles } from "../../src/luals/files.js";
import { logger } from "../../src/logger.js";
import { legacyCountCheckedFiles } from "../helpers/legacy-count.js";

/** Differential test comparing bundled-glob against pre-#27 legacy implementation (#27). */
const TOTAL_LUA_FILES = 13;
const CUSTOM_IGNORE_LUA_FILES = 17;
const VENDOR_LUA_FILES = 2;
const NESTED_LUA_FILES = 6;

describe("countCheckedFiles() parity with the pre-#27 implementation", () => {
  let root: string;

  const writeConfig = (name: string, cfg: unknown): string => {
    const configPath = path.join(root, `.luarc-${name}.json`);
    fs.writeFileSync(configPath, JSON.stringify(cfg), "utf-8");
    return configPath;
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-parity-"));
    const write = (rel: string, content = "-- fixture") => {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };

    for (const file of [
      "keep.lua",
      "UPPER.LUA",
      ".hidden.lua",
      "notes.txt",
      ".dotdir/inside.lua",
      "node_modules/pkg/index.lua",
      ".git/hooks/x.lua",
      ".vscode/ext.lua",
      ".nanos-lint/y.lua",
      "vendor/a.lua",
      "vendor/deep/b.lua",
      "build/c.lua",
      "deep/nested/d.lua",
      "deep/nested/item-1.lua",
      "deep/nested/item-a.lua",
      "deep/nested/item-10.lua",
      "deep/nested/temp-a.lua",
      "deep/nested/temp-aa.lua",
      "deep/nested/cache.tmp",
      "deep/nested/notes.bak",
    ]) {
      write(file);
    }
    fs.mkdirSync(path.join(root, "emptydir"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const parityCases: ReadonlyArray<readonly [string, (tree: string) => unknown | undefined]> = [
    ["no configuration file", () => undefined],
    ["an empty configuration object", () => ({})],
    [
      "the explicit default ignoreDir list",
      () => ({ workspace: { ignoreDir: [".git", ".vscode", ".nanos-lint", "node_modules"] } }),
    ],
    ["a nested ignoreDir path", () => ({ workspace: { ignoreDir: ["deep/nested"] } })],
    ["ignoreDir overriding the defaults", () => ({ workspace: { ignoreDir: ["node_modules"] } })],
    [
      "an absolute ignoreDir path",
      (tree) => ({ workspace: { ignoreDir: [path.join(tree, "vendor")] } }),
    ],
    ["an absolute exclude pattern", (tree) => ({ files: { exclude: [`${path.join(tree, "vendor")}/**`] } })],
    ["a basename exclude pattern", () => ({ files: { exclude: ["*.bak"] } })],
    ["a leading-globstar exclude pattern", () => ({ files: { exclude: ["**/nested/**"] } })],
    ["a leading-globstar directory pattern", () => ({ files: { exclude: ["**/deep/**"] } })],
    ["a literal directory exclude", () => ({ files: { exclude: ["vendor"] } })],
    ["a nested literal exclude", () => ({ files: { exclude: ["deep/nested"] } })],
    ["a single-character wildcard", () => ({ files: { exclude: ["**/temp-?.lua"] } })],
    ["Windows-style backslash separators", () => ({ files: { exclude: ["deep\\nested\\*.lua"] } })],
    ["a negation prefix", () => ({ files: { exclude: ["!keep.lua"] } })],
    ["a dot-directory exclude", () => ({ files: { exclude: [".dotdir/**"] } })],
    ["brace alternatives with non-Lua extensions", () => ({ files: { exclude: ["**/*.{bak,tmp}"] } })],
    [
      "ignoreDir and files.exclude together",
      () => ({ workspace: { ignoreDir: ["vendor"] }, files: { exclude: ["**/*.bak"] } }),
    ],
    ["a pattern excluding every Lua file", () => ({ files: { exclude: ["**/*.lua"] } })],
  ];

  it.each(parityCases)("matches the legacy implementation for %s", (name, buildConfig) => {
    const cfg = buildConfig(root);
    const configPath =
      cfg === undefined
        ? undefined
        : writeConfig(name.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), cfg);

    expect(countCheckedFiles(root, configPath)).toBe(legacyCountCheckedFiles(root, configPath));
  });

  it("matches the legacy implementation for single-file targets", () => {
    for (const [relativePath, expected] of [
      ["keep.lua", 1],
      ["UPPER.LUA", 1],
      ["notes.txt", 0],
      ["deep", NESTED_LUA_FILES],
    ] as const) {
      const target = path.join(root, relativePath);
      expect(countCheckedFiles(target)).toBe(expected);
      expect(legacyCountCheckedFiles(target)).toBe(expected);
    }
  });

  it("counts every non-ignored Lua file by default", () => {
    expect(countCheckedFiles(root)).toBe(TOTAL_LUA_FILES);
  });

  describe("intended behaviour differences (#27)", () => {
    it("honors a trailing slash on ignoreDir entries", () => {
      const configPath = writeConfig("trailing-slash", { workspace: { ignoreDir: ["vendor/"] } });

      // Legacy compared "vendor/" against directory names, so nothing matched.
      expect(legacyCountCheckedFiles(root, configPath)).toBe(CUSTOM_IGNORE_LUA_FILES);
      expect(countCheckedFiles(root, configPath)).toBe(CUSTOM_IGNORE_LUA_FILES - VENDOR_LUA_FILES);
    });

    it("supports glob wildcards in ignoreDir entries", () => {
      const configPath = writeConfig("ignore-wildcard", { workspace: { ignoreDir: ["deep/*"] } });

      expect(legacyCountCheckedFiles(root, configPath)).toBe(CUSTOM_IGNORE_LUA_FILES);
      expect(countCheckedFiles(root, configPath)).toBe(CUSTOM_IGNORE_LUA_FILES - NESTED_LUA_FILES);
    });

    it("honors a ./ prefix in exclude patterns", () => {
      const configPath = writeConfig("dot-slash", { files: { exclude: ["./vendor/**"] } });

      expect(legacyCountCheckedFiles(root, configPath)).toBe(TOTAL_LUA_FILES);
      expect(countCheckedFiles(root, configPath)).toBe(TOTAL_LUA_FILES - VENDOR_LUA_FILES);
    });

    it("supports character classes", () => {
      const configPath = writeConfig("char-class", { files: { exclude: ["**/item-[0-9].lua"] } });
      expect(legacyCountCheckedFiles(root, configPath)).toBe(TOTAL_LUA_FILES);
      expect(countCheckedFiles(root, configPath)).toBe(TOTAL_LUA_FILES - 1);
    });

    it("supports brace alternatives that target Lua files", () => {
      const configPath = writeConfig("braces", {
        files: { exclude: ["**/{item-a,item-10}.lua"] },
      });

      expect(legacyCountCheckedFiles(root, configPath)).toBe(TOTAL_LUA_FILES);
      expect(countCheckedFiles(root, configPath)).toBe(TOTAL_LUA_FILES - 2);
    });

    it("skips unusable exclude values instead of throwing", () => {
      const configPath = writeConfig("non-string", { files: { exclude: [42, null, {}] } });

      expect(() => legacyCountCheckedFiles(root, configPath)).toThrow(TypeError);
      expect(countCheckedFiles(root, configPath)).toBe(TOTAL_LUA_FILES);
    });

    it("never traverses symlinked directories", () => {
      const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-parity-link-"));
      try {
        const projectDir = path.join(linkParent, "project");
        fs.cpSync(root, projectDir, { recursive: true });
        try {
          fs.symlinkSync(
            path.join(projectDir, "deep"),
            path.join(projectDir, "escape"),
            process.platform === "win32" ? "junction" : "dir"
          );
        } catch (err) {
          void err;
          return;
        }

        expect(legacyCountCheckedFiles(projectDir)).toBe(TOTAL_LUA_FILES + NESTED_LUA_FILES);
        expect(countCheckedFiles(projectDir)).toBe(TOTAL_LUA_FILES);
      } finally {
        fs.rmSync(linkParent, { recursive: true, force: true });
      }
    });
  });

  describe("absolute patterns (#27)", () => {
    it("skips absolute ignoreDir and exclude entries on every platform", () => {
      const ignoreDirConfig = writeConfig("absolute-ignore", {
        workspace: {
          ignoreDir: [path.join(root, "vendor"), "C:/somewhere/vendor", "/etc/lua"],
        },
      });
      expect(countCheckedFiles(root, ignoreDirConfig)).toBe(CUSTOM_IGNORE_LUA_FILES);

      const excludeConfig = writeConfig("absolute-exclude", {
        files: { exclude: [`${path.join(root, "vendor")}/**`, "D:/tmp/**"] },
      });
      expect(countCheckedFiles(root, excludeConfig)).toBe(TOTAL_LUA_FILES);
    });
  });

  describe("pattern complexity budget (#27)", () => {
    it("skips an over-budget pattern that would otherwise exclude a file", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-budget-"));
      try {
        fs.writeFileSync(path.join(probeRoot, "aaaaaaa.lua"), "-- fixture");

        const overBudget = path.join(probeRoot, ".luarc-over-budget.json");
        fs.writeFileSync(
          overBudget,
          JSON.stringify({ files: { exclude: ["**/*a*a*a*a.lua"] } }),
          "utf-8"
        );
        expect(countCheckedFiles(probeRoot, overBudget)).toBe(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("too complex"));

        const realistic = path.join(probeRoot, ".luarc-realistic.json");
        fs.writeFileSync(
          realistic,
          JSON.stringify({ files: { exclude: ["**/*a*a.lua"] } }),
          "utf-8"
        );
        expect(countCheckedFiles(probeRoot, realistic)).toBe(0);
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(probeRoot, { recursive: true, force: true });
      }
    });

    it("bounds the cost of wildcard-heavy multi-segment patterns", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const segment = "*a*a*a*a";
      const configPath = writeConfig("multi-segment", {
        files: { exclude: [`**/${segment}/${segment}/${segment}/*a*a*a*z.lua`] },
      });

      try {
        const started = Date.now();
        expect(countCheckedFiles(root, configPath)).toBe(TOTAL_LUA_FILES);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("too complex"));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("still applies realistic patterns of the same shape", () => {
      const configPath = writeConfig("realistic-patterns", {
        files: { exclude: ["**/{nested,{vendor,build}}/**", "**/*.min.*", "**/*test*/**/*.lua"] },
      });

      expect(countCheckedFiles(root, configPath)).toBe(4);
    });
  });
});
