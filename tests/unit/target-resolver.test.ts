import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  findCommonAncestorDirectory,
  matchesTargetPaths,
  filterReportByTargetPaths,
  resolveCheckTargets,
} from "../../src/target-resolver.js";
import { LuaLSError } from "../../src/errors.js";

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
  });

  describe("resolveCheckTargets", () => {
    it("resolves default path when no paths provided", () => {
      const { rootPath, targetPaths } = resolveCheckTargets();
      expect(rootPath).toBe(".");
      expect(targetPaths).toEqual(["."]);
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
      expect(rootPath).toBe(path.resolve("tests/fixtures/realms"));
      expect(targetPaths).toEqual([dir1, dir2]);
    });

    it("handles temporary directories and files cleanly", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-target-res-"));
      try {
        const fileA = path.join(tempDir, "a.lua");
        const fileB = path.join(tempDir, "b.lua");
        fs.writeFileSync(fileA, "local a = 1", "utf-8");
        fs.writeFileSync(fileB, "local b = 2", "utf-8");

        const { rootPath, targetPaths } = resolveCheckTargets([fileA, fileB]);
        expect(rootPath).toBe(tempDir);
        expect(targetPaths).toEqual([fileA, fileB]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
