import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  computeUnrequestedExclusions,
  filterReportByTargetPaths,
  findCommonAncestorDirectory,
  findProjectRoot,
  getCanonicalPath,
  isFilesystemRoot,
  matchesTargetPaths,
  resolveCheckTargets,
} from "../../src/target-resolver.js";
import { ConfigError, LuaLSError } from "../../src/errors.js";

/**
 * `true` when this platform lets the test suite create symlinks. Creating them needs
 * elevation on Windows, and silently returning from inside a test would report success
 * without asserting anything, so the capability is probed once and surfaced as a skip.
 */
const canCreateSymlinks = ((): boolean => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-symlink-probe-"));
  try {
    fs.symlinkSync(probeDir, path.join(probeDir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

describe("target-resolver module", () => {
  describe("findCommonAncestorDirectory", () => {
    it("returns current working directory when paths array is empty", () => {
      expect(findCommonAncestorDirectory([])).toBe(path.resolve("."));
    });

    it("returns the directory itself when a single directory path is passed", () => {
      const dir = path.resolve("tests/pass");
      expect(findCommonAncestorDirectory([dir])).toBe(dir);
    });

    it("returns the parent directory when a single file path is passed", () => {
      const file = path.resolve("tests/fail/type_mismatch.lua");
      expect(findCommonAncestorDirectory([file])).toBe(path.dirname(file));
    });

    it("computes lowest common ancestor for multiple sibling directories", () => {
      const dir1 = path.resolve("tests/fixtures/realms/Shared");
      const dir2 = path.resolve("tests/fixtures/realms/Server");
      const expected = path.resolve("tests/fixtures/realms");
      expect(findCommonAncestorDirectory([dir1, dir2])).toBe(expected);
    });

    it("computes lowest common ancestor for files in different subdirectories", () => {
      const file1 = path.resolve("tests/fixtures/realms/Shared/bridge.lua");
      const file2 = path.resolve("tests/fixtures/realms/Server/combat.lua");
      const expected = path.resolve("tests/fixtures/realms");
      expect(findCommonAncestorDirectory([file1, file2])).toBe(expected);
    });

    it("computes common ancestor for a directory and a file", () => {
      const dir = path.resolve("tests/fixtures/realms/Shared");
      const file = path.resolve("tests/fixtures/realms/Server/combat.lua");
      const expected = path.resolve("tests/fixtures/realms");
      expect(findCommonAncestorDirectory([dir, file])).toBe(expected);
    });

    it("throws ConfigError when paths are on different drives on Windows", () => {
      if (process.platform === "win32") {
        expect(() => findCommonAncestorDirectory(["C:\\alpha", "D:\\beta"])).toThrow(ConfigError);
      }
    });
  });

  describe("isFilesystemRoot", () => {
    it("identifies root filesystem directories", () => {
      expect(isFilesystemRoot("/")).toBe(true);
      expect(isFilesystemRoot("C:/")).toBe(true);
      expect(isFilesystemRoot("D:\\")).toBe(true);
      expect(isFilesystemRoot("C:")).toBe(true);
      expect(isFilesystemRoot("/home")).toBe(false);
      expect(isFilesystemRoot("C:/Users")).toBe(false);
    });
  });

  describe("findProjectRoot", () => {
    it("discovers enclosing project root containing .luarc.json", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-find-root-"));
      try {
        fs.writeFileSync(path.join(tempDir, ".luarc.json"), "{}", "utf-8");
        const subDir = path.join(tempDir, "Server", "Modules");
        fs.mkdirSync(subDir, { recursive: true });

        expect(findProjectRoot(subDir)).toBe(tempDir);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("stops searching at .git boundary", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-git-bound-"));
      try {
        fs.mkdirSync(path.join(tempDir, ".git"));
        const subDir = path.join(tempDir, "sub");
        fs.mkdirSync(subDir);

        expect(findProjectRoot(subDir)).toBe(subDir);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("computeUnrequestedExclusions", () => {
    it("returns empty array when targetPaths is empty or includes root", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-unreq-"));
      try {
        expect(computeUnrequestedExclusions(tempDir, [])).toEqual([]);
        expect(computeUnrequestedExclusions(tempDir, ["."])).toEqual([]);
        expect(computeUnrequestedExclusions(tempDir, [""])).toEqual([]);
        expect(computeUnrequestedExclusions(tempDir, [tempDir])).toEqual([]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("excludes sibling directories and files outside targeted paths", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-unreq-"));
      try {
        const sharedDir = path.join(tempDir, "Shared");
        const serverDir = path.join(tempDir, "Server");
        const unrelatedDir = path.join(tempDir, "Unrelated");
        fs.mkdirSync(sharedDir);
        fs.mkdirSync(serverDir);
        fs.mkdirSync(unrelatedDir);
        fs.writeFileSync(path.join(tempDir, "root_leak.lua"), "local a = 1", "utf-8");
        fs.writeFileSync(path.join(unrelatedDir, "provider.lua"), "Provider = {}", "utf-8");

        const exclusions = computeUnrequestedExclusions(tempDir, ["Shared", "Server"]);
        expect(exclusions).toContain("Unrelated/**");
        expect(exclusions).toContain("root_leak.lua");
        expect(exclusions).not.toContain("Shared/**");
        expect(exclusions).not.toContain("Server/**");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("escapes glob metacharacters so unusual sibling names are matched literally", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-unreq-glob-"));
      try {
        fs.mkdirSync(path.join(tempDir, "keep"));
        fs.mkdirSync(path.join(tempDir, "extra[1]"));
        fs.writeFileSync(path.join(tempDir, "weird{2}.lua"), "local w = 1", "utf-8");

        const exclusions = computeUnrequestedExclusions(tempDir, [path.join(tempDir, "keep")]);

        // LuaLS only understands backslash escapes, and unescaped `[`/`{` are parsed as
        // character ranges or brace groups, which would leave these siblings loaded.
        expect(exclusions).toContain("extra\\[1\\]/**");
        expect(exclusions).toContain("weird\\{2\\}.lua");
        expect(exclusions).not.toContain("keep/**");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("excludes unrequested siblings inside dot-directories", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-unreq-dot-"));
      try {
        fs.mkdirSync(path.join(tempDir, ".hidden", "sub"), { recursive: true });
        fs.mkdirSync(path.join(tempDir, ".hidden", "other"), { recursive: true });
        fs.mkdirSync(path.join(tempDir, ".sibling"));
        fs.writeFileSync(path.join(tempDir, ".hidden", "other", "leak.lua"), "Leak = 1", "utf-8");

        const exclusions = computeUnrequestedExclusions(tempDir, [
          path.join(tempDir, ".hidden", "sub"),
        ]);
        expect(exclusions).toHaveLength(2);
        expect(exclusions).toContain(".hidden/other/**");
        expect(exclusions).toContain(".sibling/**");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("recurses into ancestors of nested targets without excluding them", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-unreq-nested-"));
      try {
        for (const dir of ["Server/Modules", "Server/Legacy", "Shared", "Other"]) {
          fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
        }

        const exclusions = computeUnrequestedExclusions(tempDir, [
          path.join(tempDir, "Server", "Modules"),
        ]);

        expect(exclusions).toContain("Server/Legacy/**");
        expect(exclusions).toContain("Shared/**");
        expect(exclusions).toContain("Other/**");
        expect(exclusions).not.toContain("Server/**");
        expect(exclusions).not.toContain("Server/Modules/**");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("matchesTargetPaths", () => {
    const root = path.resolve("tests/fixtures/realms");

    it("matches all paths when targetPaths is empty or root directory", () => {
      expect(matchesTargetPaths("Shared/bridge.lua", root, [])).toBe(true);
      expect(matchesTargetPaths("Shared/bridge.lua", root, ["."])).toBe(true);
      expect(matchesTargetPaths("Shared/bridge.lua", root, [""])).toBe(true);
    });

    it("matches files located within targeted directories", () => {
      const targets = ["Shared", "Server"];
      expect(matchesTargetPaths("Shared/bridge.lua", root, targets)).toBe(true);
      expect(matchesTargetPaths("Server/combat.lua", root, targets)).toBe(true);
      expect(matchesTargetPaths("Client/hud.lua", root, targets)).toBe(false);
      expect(matchesTargetPaths("main.lua", root, targets)).toBe(false);
    });

    it("supports trailing slashes and relative path prefixes in target paths", () => {
      const targets = ["./Shared/", "Server/"];
      expect(matchesTargetPaths("Shared/bridge.lua", root, targets)).toBe(true);
      expect(matchesTargetPaths("Server/combat.lua", root, targets)).toBe(true);
      expect(matchesTargetPaths("Client/hud.lua", root, targets)).toBe(false);
    });

    it("matches exact target file paths without matching other files in the same folder", () => {
      const targets = ["Server/combat.lua"];
      expect(matchesTargetPaths("Server/combat.lua", root, targets)).toBe(true);
      expect(matchesTargetPaths("Server/other.lua", root, targets)).toBe(false);
    });

    it.skipIf(!canCreateSymlinks)("matches targets through symlinked paths", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-sym-match-"));
      try {
        const realTargetDir = path.join(tempDir, "real_folder");
        fs.mkdirSync(realTargetDir);
        fs.writeFileSync(path.join(realTargetDir, "code.lua"), "local x = 1", "utf-8");

        const linkTargetDir = path.join(tempDir, "link_folder");
        fs.symlinkSync(realTargetDir, linkTargetDir, "dir");

        const canonicalRoot = getCanonicalPath(realTargetDir);
        expect(matchesTargetPaths("code.lua", canonicalRoot, [linkTargetDir])).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("filterReportByTargetPaths", () => {
    const root = path.resolve("tests/fixtures/realms");
    const sampleReport = {
      [`file:///${root.replace(/\\/g, "/")}/Shared/bridge.lua`]: [
        {
          code: "test",
          message: "test msg",
          severity: 1 as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
      [`file:///${root.replace(/\\/g, "/")}/Client/hud.lua`]: [
        {
          code: "test",
          message: "client msg",
          severity: 1 as const,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
    };

    it("returns original report when targeting root", () => {
      const filtered = filterReportByTargetPaths(sampleReport, root, ["."]);
      expect(Object.keys(filtered)).toHaveLength(2);
    });

    it("filters out diagnostics for files outside requested target paths", () => {
      const filtered = filterReportByTargetPaths(sampleReport, root, ["Shared"]);
      const keys = Object.keys(filtered);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain("Shared/bridge.lua");
    });

    it.skipIf(!canCreateSymlinks)("preserves diagnostics when target path is a symlink", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-sym-filter-"));
      try {
        const realDir = path.join(tempDir, "real");
        fs.mkdirSync(realDir);
        const luaFile = path.join(realDir, "err.lua");
        fs.writeFileSync(luaFile, "local x = 1", "utf-8");

        const linkDir = path.join(tempDir, "link");
        fs.symlinkSync(realDir, linkDir, "dir");

        const canonicalRoot = getCanonicalPath(realDir);
        const report = {
          [`file:///${getCanonicalPath(luaFile).replace(/\\/g, "/")}`]: [
            {
              code: "err",
              message: "syntax error",
              severity: 1 as const,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
          ],
        };

        const filtered = filterReportByTargetPaths(report, canonicalRoot, [linkDir]);
        expect(Object.keys(filtered)).toHaveLength(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("resolveCheckTargets", () => {
    it("resolves default path when no paths provided", () => {
      const { rootPath, targetPaths } = resolveCheckTargets();
      const expectedCwd = getCanonicalPath(path.resolve("."));
      expect(rootPath).toBe(".");
      expect(targetPaths).toEqual([expectedCwd]);
    });

    it("throws LuaLSError ERR_TARGET_NOT_FOUND when a path does not exist", () => {
      expect(() => resolveCheckTargets(["tests/pass", "nonexistent_dir_12345"])).toThrow(
        LuaLSError,
      );
      try {
        resolveCheckTargets(["nonexistent_dir_12345"]);
      } catch (err) {
        expect(err).toBeInstanceOf(LuaLSError);
        expect((err as LuaLSError).code).toBe("ERR_TARGET_NOT_FOUND");
      }
    });

    it("resolves multiple existing directories to common ancestor", () => {
      const dir1 = "tests/fixtures/realms/Shared";
      const dir2 = "tests/fixtures/realms/Server";
      const { rootPath, targetPaths } = resolveCheckTargets([dir1, dir2]);
      expect(rootPath).toBe(getCanonicalPath(path.resolve("tests/fixtures/realms")));
      expect(targetPaths).toEqual([
        getCanonicalPath(path.resolve(dir1)),
        getCanonicalPath(path.resolve(dir2)),
      ]);
    });

    it("handles temporary directories and files cleanly", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-target-res-"));
      try {
        const fileA = path.join(tempDir, "a.lua");
        const fileB = path.join(tempDir, "b.lua");
        fs.writeFileSync(fileA, "local a = 1", "utf-8");
        fs.writeFileSync(fileB, "local b = 2", "utf-8");

        const { rootPath, targetPaths } = resolveCheckTargets([fileA, fileB]);
        expect(rootPath).toBe(getCanonicalPath(tempDir));
        expect(targetPaths).toEqual([getCanonicalPath(fileA), getCanonicalPath(fileB)]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("re-parents nested targets onto the enclosing root holding .luarc.json", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-target-reparent-"));
      try {
        const modules = path.join(tempDir, "Server", "Modules");
        const legacy = path.join(tempDir, "Server", "Legacy");
        fs.mkdirSync(modules, { recursive: true });
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(path.join(tempDir, ".luarc.json"), "{}", "utf-8");

        const single = resolveCheckTargets([modules]);
        expect(single.rootPath).toBe(getCanonicalPath(tempDir));
        expect(single.targetPaths).toEqual([getCanonicalPath(modules)]);

        // Two targets share `Server/` as their ancestor, which is itself re-parented.
        const multiple = resolveCheckTargets([modules, legacy]);
        expect(multiple.rootPath).toBe(getCanonicalPath(tempDir));
        expect(multiple.targetPaths).toEqual([getCanonicalPath(modules), getCanonicalPath(legacy)]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("throws ConfigError ERR_ROOT_ANCESTOR when targets span the filesystem root", () => {
      // tmpdir and its volume root always share the filesystem root as ancestor, on
      // every platform (a single drive on Windows, `/` elsewhere).
      const volumeRoot = path.parse(os.tmpdir()).root;
      expect(isFilesystemRoot(findCommonAncestorDirectory([volumeRoot, os.tmpdir()]))).toBe(true);
      try {
        resolveCheckTargets([volumeRoot, os.tmpdir()]);
        expect.fail("Expected ERR_ROOT_ANCESTOR");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("ERR_ROOT_ANCESTOR");
      }
    });
  });
});
