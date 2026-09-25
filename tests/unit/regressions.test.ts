import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileUriToPath } from "../../src/types.js";
import { formatGitHubAnnotations } from "../../src/reporter.js";
import {
  loadConfigFile,
  parseJsonc,
  mergeConfigs,
  initWorkspace,
  getDefaultTemplatePath,
} from "../../src/config.js";
import {
  runLuaLSCheck,
  countCheckedFiles,
  resolveLuaLSBinary,
  FALLBACK_LUALS_VERSION,
} from "../../src/luals.js";
import { runCLI } from "../../src/cli.js";
import * as lualsModule from "../../src/luals.js";
import * as annotationsModule from "../../src/annotations.js";
import { logger } from "../../src/logger.js";
import { getSharedLuaLSBinary, isLiveTestsEnabled, seedCachedLuaLS } from "../helpers/live.js";

const liveTestsEnabled = isLiveTestsEnabled();

/**
 * `runLuaLSCheck()` validates `options.lualsBin` before executing it (#26), but
 * the regression tests below intentionally inject a fake binary that runs and
 * produces no check output. Registered binaries are treated as valid; every
 * other path still goes through the real size + `--version` validation.
 */
const mockBinaries = vi.hoisted(() => ({ allowed: new Set<string>() }));

vi.mock("../../src/luals/validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/luals/validation.js")>();
  return {
    ...actual,
    assertValidLuaLSBinary: (binaryPath: string, source: string) =>
      mockBinaries.allowed.has(binaryPath)
        ? binaryPath
        : actual.assertValidLuaLSBinary(binaryPath, source),
  };
});

describe("Regression tests for audit review issues", () => {
  describe("Issue 1: Hard failure on missing target or failed LuaLS check", () => {
    it("throws an error when targetPath does not exist", async () => {
      const missingTarget = path.join(os.tmpdir(), "nanos-non-existent-target-12345");
      const templatePath = getDefaultTemplatePath();

      await expect(
        runLuaLSCheck(missingTarget, templatePath, {
          path: missingTarget,
          checklevel: "Warning",
        }),
      ).rejects.toThrow(/does not exist/i);
    });

    it("throws an error when LuaLS fails to produce a valid check output JSON", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-luals-fail-test-"));
      try {
        const dummyLua = path.join(tempDir, "dummy.lua");
        fs.writeFileSync(dummyLua, "-- dummy");
        const templatePath = getDefaultTemplatePath();

        // Point lualsBin to a command that exits without producing check output
        let fakeBin: string;
        if (process.platform === "win32") {
          fakeBin = path.join(tempDir, "mock-fail.cmd");
          fs.writeFileSync(fakeBin, "@exit /b 1\r\n");
        } else {
          fakeBin = path.join(tempDir, "mock-fail.sh");
          fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 1\n");
          fs.chmodSync(fakeBin, 0o755);
        }

        mockBinaries.allowed.add(fakeBin);
        await expect(
          runLuaLSCheck(tempDir, templatePath, {
            path: tempDir,
            checklevel: "Warning",
            lualsBin: fakeBin,
          }),
        ).rejects.toThrow(/failed to (execute|produce diagnostic output)/i);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Issue 3: -i/--ignore does not swallow positional target path", () => {
    it("preserves the positional path when --ignore precedes it", async () => {
      const annotSpy = vi
        .spyOn(annotationsModule, "resolveAnnotations")
        .mockResolvedValue("/mock/annotations.lua");
      const checkSpy = vi.spyOn(lualsModule, "runLuaLSCheck").mockResolvedValue({
        passed: true,
        totalProblems: 0,
        totalErrors: 0,
        totalWarnings: 0,
        totalFiles: 1,
        totalFilesChecked: 1,
        diagnostics: {},
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        // check --ignore some_dir tests/pass/character.lua
        const code = await runCLI(["check", "--ignore", "some_dir", "tests/pass/character.lua"]);
        expect(code).toBe(0);

        expect(checkSpy).toHaveBeenCalledTimes(1);
        const firstCall = checkSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        const [targetPath, , options] = firstCall!;
        expect(targetPath).toBe("tests/pass/character.lua");
        expect(options.ignore).toEqual(["some_dir"]);
      } finally {
        annotSpy.mockRestore();
        checkSpy.mockRestore();
        logSpy.mockRestore();
      }
    });
  });

  describe("Issue 5: --checklevel and --format validation", () => {
    it("rejects invalid --checklevel choice", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await runCLI(["check", ".", "--checklevel", "Bogus"]);
        expect(code).toBe(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringMatching(/--checklevel.*invalid|allowed choices/i),
        );
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects invalid --format choice", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await runCLI(["check", ".", "--format", "bogus"]);
        expect(code).toBe(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringMatching(/--format.*invalid|allowed choices/i),
        );
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe("Issue 6: UTF-8 BOM tolerance in config files", () => {
    it("parses JSONC text containing a leading UTF-8 BOM", () => {
      const bomJsonc = '\uFEFF{\n  "diagnostics": {\n    "globals": ["MyGlobal"]\n  }\n}';
      const parsed = parseJsonc<{ diagnostics: { globals: string[] } }>(bomJsonc);
      expect(parsed.diagnostics.globals).toEqual(["MyGlobal"]);
    });

    it("loads config file containing a leading UTF-8 BOM", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-bom-test-"));
      try {
        const configFile = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(
          configFile,
          '\uFEFF{\n  "diagnostics": { "globals": ["BOMGlobal"] }\n}',
          "utf-8",
        );

        const loaded = loadConfigFile(configFile);
        expect(loaded.diagnostics?.globals).toEqual(["BOMGlobal"]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Issue 7: init safety and portable annotations", () => {
    it("refuses to overwrite existing .luarc.json without --force", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-init-refuse-"));
      try {
        const existingConfig = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(existingConfig, '{"diagnostics":{"globals":["KeepMe"]}}', "utf-8");

        expect(() => {
          initWorkspace(tempDir, { force: false });
        }).toThrow(/already exists/i);

        // Verify content was not modified
        const content = fs.readFileSync(existingConfig, "utf-8");
        expect(content).toContain("KeepMe");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("overwrites existing .luarc.json when force is true and writes portable relative library", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-init-force-"));
      const dummyAnnotations = path.join(tempDir, "source-annotations.lua");
      fs.writeFileSync(dummyAnnotations, "-- dummy annotations", "utf-8");
      try {
        const existingConfig = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(existingConfig, '{"old": true}', "utf-8");

        const created = initWorkspace(tempDir, { force: true, annotationsPath: dummyAnnotations });
        expect(created).toBe(existingConfig);

        const config = JSON.parse(fs.readFileSync(existingConfig, "utf-8"));
        // Library path must be portable (relative inside workspace, e.g. .nanos-lint/annotations.lua)
        expect(config.workspace?.library).toEqual([".nanos-lint/annotations.lua"]);
        // Verify annotations.lua was copied into workspace
        expect(fs.existsSync(path.join(tempDir, ".nanos-lint", "annotations.lua"))).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Issue 8: Passing --ignore preserves default structural exclusions", () => {
    it("retains node_modules and .git in ignoreDir when cliIgnore is passed", () => {
      const base = loadConfigFile(getDefaultTemplatePath());
      const override = {
        workspace: { ignoreDir: ["my_custom_folder"] },
      };

      const merged = mergeConfigs(base, override, "C:/fake/defs", {
        cliIgnore: ["some_pattern/*.lua"],
      });

      // Default exclusions MUST still be present
      expect(merged.workspace?.ignoreDir).toContain("node_modules");
      expect(merged.workspace?.ignoreDir).toContain(".git");
      expect(merged.workspace?.ignoreDir).toContain("dist");
      expect(merged.workspace?.ignoreDir).toContain("vendor");
      expect(merged.workspace?.ignoreDir).toContain("my_custom_folder");
    });
  });

  describe("Issue 11: CLI error formatting without stack traces", () => {
    it("prints clean error message when config file is missing without full stack trace", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const origDebug = process.env.DEBUG;
        delete process.env.DEBUG;

        const code = await runCLI(["check", ".", "--config", "non_existent_config.json"]);
        expect(code).toBe(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringMatching(/^error: Configuration file not found/i),
        );

        if (origDebug) process.env.DEBUG = origDebug;
      } finally {
        errSpy.mockRestore();
      }
    });

    it("validates missing config file before resolving annotations", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const annotationsMod = await import("../../src/annotations.js");
      const resolveSpy = vi
        .spyOn(annotationsMod, "resolveAnnotations")
        .mockImplementation(async () => {
          throw new Error("resolveAnnotations was unexpectedly invoked before config validation");
        });
      try {
        const origDebug = process.env.DEBUG;
        delete process.env.DEBUG;

        const code = await runCLI(["check", ".", "--config", "non_existent_config.json"]);
        expect(code).toBe(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringMatching(/^error: Configuration file not found/i),
        );
        expect(resolveSpy).not.toHaveBeenCalled();

        if (origDebug) process.env.DEBUG = origDebug;
      } finally {
        resolveSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });

  describe("Issue 14: countCheckedFiles glob semantics", () => {
    it("excludes files matching *.lua at any depth", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-test-"));
      try {
        fs.writeFileSync(path.join(tempDir, "root.lua"), "-- root");
        fs.mkdirSync(path.join(tempDir, "sub"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "sub", "nested.lua"), "-- nested");

        const configPath = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(configPath, JSON.stringify({ files: { exclude: ["*.lua"] } }), "utf-8");

        const count = countCheckedFiles(tempDir, configPath);
        expect(count).toBe(0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("excludes files matching **/*.lua at any depth", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-starstar-"));
      try {
        fs.writeFileSync(path.join(tempDir, "root.lua"), "-- root");
        fs.mkdirSync(path.join(tempDir, "sub"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "sub", "nested.lua"), "-- nested");

        const configPath = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(configPath, JSON.stringify({ files: { exclude: ["**/*.lua"] } }), "utf-8");

        const count = countCheckedFiles(tempDir, configPath);
        expect(count).toBe(0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Issue 26: LUALS_BIN and --luals-bin binary validation", () => {
    it("rejects a LUALS_BIN override that points to a directory", async () => {
      const origBin = process.env.LUALS_BIN;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-bin-dir-"));
      try {
        process.env.LUALS_BIN = tempDir;

        await expect(resolveLuaLSBinary()).rejects.toMatchObject({
          name: "LuaLSError",
          code: "ERR_LUALS_BIN_INVALID",
        });
        await expect(resolveLuaLSBinary()).rejects.toThrow(/LUALS_BIN.*not a regular file/);
      } finally {
        if (origBin !== undefined) {
          process.env.LUALS_BIN = origBin;
        } else {
          delete process.env.LUALS_BIN;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects a LUALS_BIN override that does not exist", async () => {
      const origBin = process.env.LUALS_BIN;
      const missingBin = path.join(os.tmpdir(), `nanos-missing-luals-${Date.now()}`);
      try {
        process.env.LUALS_BIN = missingBin;

        await expect(resolveLuaLSBinary()).rejects.toThrow(
          /LUALS_BIN.*does not exist or cannot be read/,
        );
      } finally {
        if (origBin !== undefined) {
          process.env.LUALS_BIN = origBin;
        } else {
          delete process.env.LUALS_BIN;
        }
      }
    });

    it("rejects an invalid --luals-bin before executing the check", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-option-bin-"));
      try {
        fs.writeFileSync(path.join(tempDir, "script.lua"), "local a = 1");

        await expect(
          runLuaLSCheck(tempDir, getDefaultTemplatePath(), {
            path: tempDir,
            checklevel: "Warning",
            lualsBin: tempDir,
          }),
        ).rejects.toThrow(/--luals-bin.*not a regular file/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Issue 27: countCheckedFiles glob engine", () => {
    it("supports brace expansion, character classes and single-character wildcards", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-syntax-"));
      try {
        const configPath = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            files: {
              exclude: [
                "**/*.{bak,tmp}",
                "**/drop-{1,2}.lua",
                "**/item-[0-9].lua",
                "**/temp-?.lua",
                "**/nested/**",
              ],
            },
          }),
          "utf-8",
        );
        for (const file of [
          "keep.lua",
          "notes.bak",
          "cache.tmp",
          "drop-1.lua",
          "drop-2.lua",
          "item-1.lua",
          "item-a.lua",
          "item-10.lua",
          "temp-a.lua",
          "temp-aa.lua",
        ]) {
          fs.writeFileSync(path.join(tempDir, file), "-- fixture");
        }
        fs.mkdirSync(path.join(tempDir, "deep", "nested"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "deep", "nested", "deep.lua"), "-- fixture");

        // The brace case has to target `.lua` files to affect the total: brace
        // expansion of non-Lua extensions (`**/*.{bak,tmp}`) can only match files
        // that are not counted anyway. Removed here: `drop-1.lua` and
        // `drop-2.lua` (braces), `item-1.lua` (character class), `temp-a.lua`
        // (`?`) and `deep/nested/deep.lua`, leaving `keep.lua`, `item-a.lua`
        // (not a digit), `item-10.lua` (two digits) and `temp-aa.lua` (two
        // characters after `temp-`).
        expect(countCheckedFiles(tempDir, configPath)).toBe(4);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("stays fast on adversarial wildcard and brace patterns (ReDoS regression)", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-redos-"));
      try {
        // A long run of "a" segments plus a file name made only of "a" characters
        // is the classic backtracking bait for glob matching, and repeated brace
        // groups expand combinatorially.
        const deepDir = path.join(tempDir, "a".repeat(24), "a".repeat(24), "a".repeat(24));
        fs.mkdirSync(deepDir, { recursive: true });
        for (let i = 0; i < 40; i++) {
          fs.writeFileSync(path.join(deepDir, `file${i}.lua`), "-- fixture");
        }
        fs.writeFileSync(path.join(deepDir, `${"a".repeat(60)}.lua`), "-- fixture");
        fs.writeFileSync(path.join(tempDir, "keep.lua"), "-- fixture");

        const configPath = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            files: {
              exclude: [
                `**/${"*a".repeat(24)}z.lua`,
                `**/${"{a,b}".repeat(16)}p.lua`,
                `**/${"*".repeat(60)}b.lua`,
                // Complex but affordable: nested braces and globstars stay supported.
                "**/{nested,{vendor,build}}/**",
              ],
            },
          }),
          "utf-8",
        );

        const started = Date.now();
        const count = countCheckedFiles(tempDir, configPath);
        const elapsed = Date.now() - started;

        expect(count).toBe(42);
        // Generous budget: the AST-based matcher needs milliseconds, while a
        // backtracking regex translation of these patterns would not finish.
        expect(elapsed).toBeLessThan(5000);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("warns and skips patterns beyond the matching complexity budget", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-budget-"));
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        fs.writeFileSync(path.join(tempDir, "a.lua"), "-- fixture");
        const configPath = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(
          configPath,
          // Five ambiguous wildcards in a single segment are enough to skip it.
          JSON.stringify({ files: { exclude: ["**/*a*a*a*a*z.lua"] } }),
          "utf-8",
        );

        expect(countCheckedFiles(tempDir, configPath)).toBe(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("too complex"));
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("skips unusable exclude patterns instead of under-counting files", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-unusable-"));
      try {
        fs.writeFileSync(path.join(tempDir, "a.lua"), "-- fixture");
        fs.writeFileSync(path.join(tempDir, "b.lua"), "-- fixture");
        const configPath = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            files: { exclude: ["", ".", "x".repeat(70_000), "bad\u0000pattern", 42, null] },
          }),
          "utf-8",
        );

        expect(countCheckedFiles(tempDir, configPath)).toBe(2);

        // Non-array JSON values are user input too: fall back to the defaults.
        fs.writeFileSync(
          configPath,
          JSON.stringify({ files: { exclude: "*.lua" }, workspace: { ignoreDir: 7 } }),
          "utf-8",
        );
        expect(countCheckedFiles(tempDir, configPath)).toBe(2);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("does not count symlinks or traverse symlinked directories (#21)", () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-symlink-"));
      try {
        const projectDir = path.join(tempRoot, "project");
        const outsideDir = path.join(tempRoot, "outside");
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });
        fs.writeFileSync(path.join(projectDir, "real.lua"), "-- fixture");
        fs.writeFileSync(path.join(outsideDir, "outside.lua"), "-- fixture");

        const linkType = process.platform === "win32" ? "junction" : "dir";
        try {
          fs.symlinkSync(outsideDir, path.join(projectDir, "escape"), linkType);
          fs.symlinkSync(
            path.join(projectDir, "real.lua"),
            path.join(projectDir, "linked.lua"),
            "file",
          );
        } catch (err) {
          // Symlink creation can require elevated privileges on Windows.
          void err;
        }

        expect(countCheckedFiles(projectDir)).toBe(1);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe("Issue 17: fileUriToPath edge cases", () => {
    it("handles UNC file URIs correctly", () => {
      const uncUri = "file://server/share/folder/script.lua";
      const converted = fileUriToPath(uncUri);
      expect(converted.replace(/\\/g, "/")).toBe("//server/share/folder/script.lua");
    });

    it("does not throw URIError on malformed percent encoding", () => {
      const malformed = "file:///path/%E0%A4%A/script.lua";
      expect(() => fileUriToPath(malformed)).not.toThrow();
    });

    it("strips leading slash from Windows drive letter URIs across all platforms", () => {
      expect(fileUriToPath("file:///C:/Users/alexa/test.lua")).toBe("C:/Users/alexa/test.lua");
      expect(fileUriToPath("file:///d:/workspace/test.lua")).toBe("D:/workspace/test.lua");
    });
  });

  describe("Issue 18: GitHub annotations escape commas in file paths", () => {
    it("escapes commas in file paths for GitHub Action annotations", () => {
      const mockResult = {
        passed: false,
        totalProblems: 1,
        totalFiles: 1,
        diagnostics: {
          "file:///workspace/path,with,comma/test.lua": [
            {
              code: "test-diag",
              message: "Some error",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              severity: 1 as const,
            },
          ],
        },
      };

      const formatted = formatGitHubAnnotations(mockResult, "/workspace");
      expect(formatted).toContain("file=path%2Cwith%2Ccomma/test.lua");
    });
  });

  describe.skipIf(!liveTestsEnabled)("Issue 4: log-level gates LuaLS progress output", () => {
    it("resolveLuaLSBinary stays silent at the default log level and logs at info", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const previousLevel = logger.getLevel();
      try {
        await getSharedLuaLSBinary();
        logger.setLevel("warn");
        await resolveLuaLSBinary("latest");
        expect(logSpy.mock.calls.map((c) => c.join(" ")).some((m) => m.includes("[luals]"))).toBe(
          false,
        );
        logger.setLevel("info");
        await resolveLuaLSBinary("latest", { reuseExisting: true });
      } finally {
        logger.setLevel(previousLevel);
        logSpy.mockRestore();
      }
    });
  });

  describe("Finding N0: initWorkspace excludes .nanos-lint from workspace diagnostics", () => {
    it("configures files.exclude and workspace.ignoreDir for .nanos-lint in initialized workspace", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-n0-init-"));
      const dummyAnnotations = path.join(tempDir, "source-annotations.lua");
      fs.writeFileSync(dummyAnnotations, "-- dummy annotations", "utf-8");
      try {
        const configFile = initWorkspace(tempDir, {
          force: true,
          annotationsPath: dummyAnnotations,
        });
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));

        // Must exclude .nanos-lint from files to prevent diagnostics on annotations.lua
        expect(config.files?.exclude).toContain(".nanos-lint/**");
        expect(config.workspace?.ignoreDir).toContain(".nanos-lint");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("mergeConfigs includes .nanos-lint in default ignore dirs", () => {
      const base = loadConfigFile(getDefaultTemplatePath());
      const merged = mergeConfigs(base, {}, "C:/fake/defs");
      expect(merged.workspace?.ignoreDir).toContain(".nanos-lint");
    });

    it("countCheckedFiles ignores files inside .nanos-lint", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-n0-count-"));
      try {
        fs.writeFileSync(path.join(tempDir, "game.lua"), "-- game code");
        const nanosDir = path.join(tempDir, ".nanos-lint");
        fs.mkdirSync(nanosDir, { recursive: true });
        fs.writeFileSync(path.join(nanosDir, "annotations.lua"), "-- vendor annotations");

        const count = countCheckedFiles(tempDir);
        expect(count).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe.skipIf(!liveTestsEnabled)(
    "Finding N1: Atomic and race-safe download and extraction",
    () => {
      it("safely handles concurrent download/extraction to the same target directory", async () => {
        const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-n1-race-"));
        try {
          const { downloadAndExtractLuaLS } = await import("../../src/luals.js");
          const targetDir = path.join(tempBase, "luals-target");

          // Run 2 concurrent extractions to the exact same targetDir
          const [bin1, bin2] = await Promise.all([
            downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, targetDir),
            downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, targetDir),
          ]);

          expect(bin1).toBe(bin2);
          expect(fs.existsSync(bin1)).toBe(true);
          expect(fs.existsSync(path.join(targetDir, ".complete"))).toBe(true);

          // Verify no leftover .tmp-* directories in the parent dir
          const parentEntries = fs.readdirSync(tempBase);
          const tmpDirs = parentEntries.filter((e) => e.includes(".tmp-"));
          expect(tmpDirs.length).toBe(0);
        } finally {
          fs.rmSync(tempBase, { recursive: true, force: true });
        }
      }, 120000);
    },
  );

  describe("Finding N2: Corrupted cached LuaLS binary detection and recovery", () => {
    it("does not accept a truncated or corrupted cached binary as valid", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-n2-corrupt-"));
      try {
        const binSubdir = path.join(tempDir, "bin");
        fs.mkdirSync(binSubdir, { recursive: true });
        const binaryName =
          process.platform === "win32" ? "lua-language-server.exe" : "lua-language-server";
        const fakeCorruptBin = path.join(binSubdir, binaryName);
        fs.writeFileSync(fakeCorruptBin, "corrupted-truncated-binary-data");

        const { isBinaryValid } = await import("../../src/luals.js");
        expect(isBinaryValid(fakeCorruptBin)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it.skipIf(!liveTestsEnabled)(
      "detects and repairs corrupted targetDir when downloadAndExtractLuaLS is invoked",
      async () => {
        const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-n2-repair-"));
        try {
          const { downloadAndExtractLuaLS, isBinaryValid } = await import("../../src/luals.js");
          const corruptDir = path.join(tempBase, "corrupt-cache");
          const binSubdir = path.join(corruptDir, "bin");
          fs.mkdirSync(binSubdir, { recursive: true });
          const binaryName =
            process.platform === "win32" ? "lua-language-server.exe" : "lua-language-server";
          fs.writeFileSync(path.join(binSubdir, binaryName), "corrupted truncated file");

          const repairedBin = await downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, corruptDir, {});
          expect(isBinaryValid(repairedBin)).toBe(true);
          expect(fs.existsSync(path.join(corruptDir, ".complete"))).toBe(true);
        } finally {
          fs.rmSync(tempBase, { recursive: true, force: true });
        }
      },
      120000,
    );

    it("includes cache directory in LuaLS execution error message", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-n2-errmsg-"));
      try {
        const dummyLua = path.join(tempDir, "dummy.lua");
        fs.writeFileSync(dummyLua, "-- dummy");
        const templatePath = getDefaultTemplatePath();

        let fakeBin: string;
        if (process.platform === "win32") {
          fakeBin = path.join(tempDir, "mock-fail.cmd");
          fs.writeFileSync(fakeBin, "@exit /b 1\r\n");
        } else {
          fakeBin = path.join(tempDir, "mock-fail.sh");
          fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 1\n");
          fs.chmodSync(fakeBin, 0o755);
        }

        mockBinaries.allowed.add(fakeBin);
        await expect(
          runLuaLSCheck(tempDir, templatePath, {
            path: tempDir,
            checklevel: "Warning",
            lualsBin: fakeBin,
          }),
        ).rejects.toThrow(/Cache location:/i);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Review issues 3 & 5: LuaLS cache probe, .complete marker validation, and failed promotion cleanup", () => {
    it.skipIf(!liveTestsEnabled)(
      "reuses an existing valid cache entry without any network access",
      async () => {
        const baseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cache-reuse-"));
        const originalFetch = globalThis.fetch;
        const fetchMock = vi.fn(() => {
          throw new Error("network access is not allowed when a valid cache entry exists");
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        try {
          const seeded = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
          const resolved = await resolveLuaLSBinary(FALLBACK_LUALS_VERSION, {
            cacheDir: baseCacheDir,
          });

          expect(resolved).toBe(seeded);
          expect(fs.existsSync(resolved)).toBe(true);
          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          globalThis.fetch = originalFetch;
          fs.rmSync(baseCacheDir, { recursive: true, force: true });
        }
      },
    );

    it("does not accept cached directory if .complete marker is missing or has mismatched version", async () => {
      const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-marker-test-"));
      try {
        const { getPlatformInfo, downloadAndExtractLuaLS } = await import("../../src/luals.js");
        const info = getPlatformInfo("3.19.1");
        const corruptDir = path.join(tempBase, "luals", "3.19.1");
        const binSubdir = path.join(corruptDir, path.dirname(info.binaryRelativePath));
        fs.mkdirSync(binSubdir, { recursive: true });

        const binaryPath = path.join(corruptDir, info.binaryRelativePath);
        fs.writeFileSync(binaryPath, "fake-binary-content-missing-marker");

        // No .complete marker exists: downloadAndExtractLuaLS should not treat this as complete
        const markerPath = path.join(corruptDir, ".complete");
        expect(fs.existsSync(markerPath)).toBe(false);

        // Even with wrong version in marker:
        fs.writeFileSync(markerPath, "3.18.0", "utf-8"); // mismatched version!

        // When downloadAndExtractLuaLS runs on corruptDir, it must clean it up and not accept the mismatched version
        // Mock fetch to check that download is actually attempted rather than blindly returning binaryPath
        const originalFetch = globalThis.fetch;
        let fetchAttempted = false;
        globalThis.fetch = vi.fn().mockImplementation(() => {
          fetchAttempted = true;
          return Promise.reject(
            new Error("Network call triggered as expected because cache is invalid"),
          );
        });

        try {
          await expect(
            downloadAndExtractLuaLS("3.19.1", corruptDir, { reuseExisting: false }),
          ).rejects.toThrow();
          expect(fetchAttempted).toBe(true);
        } finally {
          globalThis.fetch = originalFetch;
        }
      } finally {
        fs.rmSync(tempBase, { recursive: true, force: true });
      }
    });

    it.skipIf(!liveTestsEnabled)(
      "cleans up broken destDir when atomic promotion fails",
      async () => {
        const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-promo-fail-"));
        try {
          const { downloadAndExtractLuaLS } = await import("../../src/luals.js");
          const targetDir = path.join(tempBase, "target");

          // Spy on renameSync: when promoting to targetDir, simulate a partial/corrupted directory creation and throw EPERM
          const origRename = fs.renameSync;
          let threw = false;
          const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
            if (String(newPath) === targetDir) {
              threw = true;
              fs.mkdirSync(targetDir, { recursive: true });
              fs.writeFileSync(path.join(targetDir, "corrupted.file"), "broken");
              const err = new Error(
                "EPERM: operation not permitted, rename",
              ) as NodeJS.ErrnoException;
              err.code = "EPERM";
              throw err;
            }
            return origRename(oldPath, newPath);
          });

          try {
            await expect(
              downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, targetDir),
            ).rejects.toThrow(/EPERM/);
            expect(threw).toBe(true);

            // Verify broken targetDir was cleaned up and not left behind
            expect(fs.existsSync(path.join(targetDir, "corrupted.file"))).toBe(false);
          } finally {
            renameSpy.mockRestore();
          }
        } finally {
          fs.rmSync(tempBase, { recursive: true, force: true });
        }
      },
    );
  });
});
