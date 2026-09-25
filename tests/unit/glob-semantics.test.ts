import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { countCheckedFiles } from "../../src/luals/files.js";
import { logger } from "../../src/logger.js";

/**
 * Golden expectations pinning `countCheckedFiles()` semantics under the bundled `glob`
 * engine (#27). The pre-#27 differential harness was removed in v3.0.0 (#33): the
 * numbers below are the contract, not a comparison against the retired walker.
 */
const DEFAULT_IGNORED_LUA_FILES = 13; // 17 fixtures minus .git/.vscode/.nanos-lint/node_modules
const ALL_LUA_FILES = 17; // no ignore rule applies
const NESTED_LUA_FILES = 6;
const VENDOR_LUA_FILES = 2;

describe("countCheckedFiles() golden semantics", () => {
  let root: string;

  const writeConfig = (name: string, cfg: unknown): string => {
    const configPath = path.join(root, `.luarc-${name}.json`);
    fs.writeFileSync(configPath, JSON.stringify(cfg), "utf-8");
    return configPath;
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-semantics-"));
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

  const goldenCases: ReadonlyArray<
    readonly [name: string, expected: number, buildConfig: (tree: string) => unknown | undefined]
  > = [
    [
      "no config file: the four built-in ignore dirs are skipped",
      DEFAULT_IGNORED_LUA_FILES,
      () => undefined,
    ],
    ["an empty config object behaves like no config file", DEFAULT_IGNORED_LUA_FILES, () => ({})],
    [
      "an explicit copy of the default ignoreDir list matches the built-in defaults",
      DEFAULT_IGNORED_LUA_FILES,
      () => ({ workspace: { ignoreDir: [".git", ".vscode", ".nanos-lint", "node_modules"] } }),
    ],
    [
      "a config file replaces the built-in ignoreDir defaults instead of extending them",
      DEFAULT_IGNORED_LUA_FILES - VENDOR_LUA_FILES,
      () => ({ workspace: { ignoreDir: ["deep/nested"] } }),
    ],
    [
      "a custom ignoreDir keeps every file outside that directory",
      ALL_LUA_FILES - 1,
      () => ({ workspace: { ignoreDir: ["node_modules"] } }),
    ],
    [
      "an absolute ignoreDir entry is skipped, so no ignore rule applies",
      ALL_LUA_FILES,
      (tree) => ({ workspace: { ignoreDir: [path.join(tree, "vendor")] } }),
    ],
    [
      "an absolute exclude entry is skipped and only the built-in ignores apply",
      DEFAULT_IGNORED_LUA_FILES,
      (tree) => ({ files: { exclude: [`${path.join(tree, "vendor")}/**`] } }),
    ],
    [
      "a non-Lua basename exclude pattern removes nothing",
      DEFAULT_IGNORED_LUA_FILES,
      () => ({ files: { exclude: ["*.bak"] } }),
    ],
    [
      "**/nested/** removes the six files under deep/nested",
      DEFAULT_IGNORED_LUA_FILES - NESTED_LUA_FILES,
      () => ({ files: { exclude: ["**/nested/**"] } }),
    ],
    [
      "**/deep/** removes vendor/deep plus deep/nested",
      ALL_LUA_FILES - VENDOR_LUA_FILES - NESTED_LUA_FILES - 3,
      () => ({ files: { exclude: ["**/deep/**"] } }),
    ],
    [
      "a literal directory name matches that directory at any depth",
      DEFAULT_IGNORED_LUA_FILES - VENDOR_LUA_FILES,
      () => ({ files: { exclude: ["vendor"] } }),
    ],
    [
      "a nested literal path matches only that directory",
      DEFAULT_IGNORED_LUA_FILES - NESTED_LUA_FILES,
      () => ({ files: { exclude: ["deep/nested"] } }),
    ],
    [
      "? matches exactly one character: temp-a.lua but not temp-aa.lua",
      DEFAULT_IGNORED_LUA_FILES - 1,
      () => ({ files: { exclude: ["**/temp-?.lua"] } }),
    ],
    [
      "backslash separators are normalized to forward slashes",
      DEFAULT_IGNORED_LUA_FILES - NESTED_LUA_FILES,
      () => ({ files: { exclude: ["deep\\nested\\*.lua"] } }),
    ],
    [
      "a bare negation prefix is inert without a positive pattern to re-include into",
      DEFAULT_IGNORED_LUA_FILES,
      () => ({ files: { exclude: ["!keep.lua"] } }),
    ],
    [
      "a dot-directory pattern excludes hidden directories too",
      DEFAULT_IGNORED_LUA_FILES - 1,
      () => ({ files: { exclude: [".dotdir/**"] } }),
    ],
    [
      "brace alternatives that only name non-Lua extensions match nothing",
      DEFAULT_IGNORED_LUA_FILES,
      () => ({ files: { exclude: ["**/*.{bak,tmp}"] } }),
    ],
    [
      "files.exclude combines with a custom ignoreDir",
      ALL_LUA_FILES - VENDOR_LUA_FILES,
      () => ({ workspace: { ignoreDir: ["vendor"] }, files: { exclude: ["**/*.bak"] } }),
    ],
    ["**/*.lua can exclude every Lua file", 0, () => ({ files: { exclude: ["**/*.lua"] } })],
  ];

  it.each(goldenCases)("%s", (_name, expected, buildConfig) => {
    const cfg = buildConfig(root);
    const configPath =
      cfg === undefined
        ? undefined
        : writeConfig(_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), cfg);

    expect(countCheckedFiles(root, configPath)).toBe(expected);
  });

  it("counts single-file targets by extension, case-insensitively", () => {
    for (const [relativePath, expected] of [
      ["keep.lua", 1],
      ["UPPER.LUA", 1],
      ["notes.txt", 0],
      ["deep", NESTED_LUA_FILES],
    ] as const) {
      expect(countCheckedFiles(path.join(root, relativePath))).toBe(expected);
    }
  });

  it("counts every non-ignored Lua file by default", () => {
    expect(countCheckedFiles(root)).toBe(DEFAULT_IGNORED_LUA_FILES);
  });

  describe("glob semantics (#27 contract)", () => {
    it("honors a trailing slash on ignoreDir entries", () => {
      const configPath = writeConfig("trailing-slash", { workspace: { ignoreDir: ["vendor/"] } });

      expect(countCheckedFiles(root, configPath)).toBe(ALL_LUA_FILES - VENDOR_LUA_FILES);
    });

    it("supports glob wildcards in ignoreDir entries", () => {
      const configPath = writeConfig("ignore-wildcard", { workspace: { ignoreDir: ["deep/*"] } });

      expect(countCheckedFiles(root, configPath)).toBe(ALL_LUA_FILES - NESTED_LUA_FILES);
    });

    it("honors a ./ prefix in exclude patterns", () => {
      const configPath = writeConfig("dot-slash", { files: { exclude: ["./vendor/**"] } });

      expect(countCheckedFiles(root, configPath)).toBe(
        DEFAULT_IGNORED_LUA_FILES - VENDOR_LUA_FILES,
      );
    });

    it("supports character classes", () => {
      const configPath = writeConfig("char-class", { files: { exclude: ["**/item-[0-9].lua"] } });

      expect(countCheckedFiles(root, configPath)).toBe(DEFAULT_IGNORED_LUA_FILES - 1);
    });

    it("supports brace alternatives that target Lua files", () => {
      const configPath = writeConfig("braces", {
        files: { exclude: ["**/{item-a,item-10}.lua"] },
      });

      expect(countCheckedFiles(root, configPath)).toBe(DEFAULT_IGNORED_LUA_FILES - 2);
    });

    it("skips unusable exclude values instead of throwing", () => {
      const configPath = writeConfig("non-string", { files: { exclude: [42, null, {}] } });

      expect(countCheckedFiles(root, configPath)).toBe(DEFAULT_IGNORED_LUA_FILES);
    });

    it("never traverses symlinked directories", () => {
      const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-semantics-link-"));
      try {
        const projectDir = path.join(linkParent, "project");
        fs.cpSync(root, projectDir, { recursive: true });
        try {
          fs.symlinkSync(
            path.join(projectDir, "deep"),
            path.join(projectDir, "escape"),
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch (err) {
          void err;
          return;
        }

        expect(countCheckedFiles(projectDir)).toBe(DEFAULT_IGNORED_LUA_FILES);
      } finally {
        fs.rmSync(linkParent, { recursive: true, force: true });
      }
    });
  });

  describe("rejected pattern shapes (v3.0.0, #33)", () => {
    it("warns about negation prefixes and does not let them re-include files", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const configPath = writeConfig("negation-combo", {
        files: { exclude: ["**/*.lua", "!keep.lua"] },
      });

      try {
        // LuaLS's gitignore matcher has no negation support, so every Lua file is
        // excluded and `!keep.lua` must not silently re-include one here either.
        expect(countCheckedFiles(root, configPath)).toBe(0);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("negation prefixes"));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("warns about absolute patterns and skips them", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const configPath = writeConfig("absolute-warning", {
        workspace: { ignoreDir: [path.join(root, "vendor")] },
      });

      try {
        expect(countCheckedFiles(root, configPath)).toBe(ALL_LUA_FILES);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("absolute patterns are not supported"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("never counts symlinked Lua files or traverses symlinked directories", () => {
      const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-symlink-file-"));
      try {
        fs.writeFileSync(path.join(linkRoot, "real.lua"), "-- fixture");
        fs.writeFileSync(path.join(linkRoot, "other.lua"), "-- fixture");
        fs.mkdirSync(path.join(linkRoot, "sub"));
        fs.writeFileSync(path.join(linkRoot, "sub", "inner.lua"), "-- fixture");
        try {
          fs.symlinkSync(path.join(linkRoot, "real.lua"), path.join(linkRoot, "linked.lua"));
          fs.symlinkSync(
            path.join(linkRoot, "sub"),
            path.join(linkRoot, "linked-dir"),
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch (err) {
          void err;
          return;
        }

        expect(countCheckedFiles(linkRoot)).toBe(3);
      } finally {
        fs.rmSync(linkRoot, { recursive: true, force: true });
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
      expect(countCheckedFiles(root, ignoreDirConfig)).toBe(ALL_LUA_FILES);

      const excludeConfig = writeConfig("absolute-exclude", {
        files: { exclude: [`${path.join(root, "vendor")}/**`, "D:/tmp/**"] },
      });
      expect(countCheckedFiles(root, excludeConfig)).toBe(DEFAULT_IGNORED_LUA_FILES);
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
          "utf-8",
        );
        expect(countCheckedFiles(probeRoot, overBudget)).toBe(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("too complex"));

        const realistic = path.join(probeRoot, ".luarc-realistic.json");
        fs.writeFileSync(
          realistic,
          JSON.stringify({ files: { exclude: ["**/*a*a.lua"] } }),
          "utf-8",
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
        expect(countCheckedFiles(root, configPath)).toBe(DEFAULT_IGNORED_LUA_FILES);
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
