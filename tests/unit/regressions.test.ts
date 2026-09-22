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
} from "../../src/luals.js";
import { runCLI, createProgram } from "../../src/cli.js";

describe("Regression tests for audit review issues", () => {
  describe("Issue 1: Hard failure on missing target or failed LuaLS check", () => {
    it("throws an error when targetPath does not exist", async () => {
      const missingTarget = path.join(os.tmpdir(), "nanos-non-existent-target-12345");
      const templatePath = getDefaultTemplatePath();

      await expect(
        runLuaLSCheck(missingTarget, templatePath, {
          path: missingTarget,
          checklevel: "Warning",
        })
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

        await expect(
          runLuaLSCheck(tempDir, templatePath, {
            path: tempDir,
            checklevel: "Warning",
            lualsBin: fakeBin,
          })
        ).rejects.toThrow(/failed to (execute|produce diagnostic output)/i);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Issue 3: -i/--ignore does not swallow positional target path", () => {
    it("preserves positional path when --ignore precedes it", () => {
      const program = createProgram();
      let capturedPath: string | undefined;
      let capturedIgnore: string[] | undefined;

      program
        .command("test-check [path]")
        .option("-i, --ignore <pattern>", "ignore pattern", (val, prev: string[] = []) => prev.concat(val))
        .action((targetPath: string = ".", opts: { ignore?: string[] }) => {
          capturedPath = targetPath;
          capturedIgnore = opts.ignore;
        });

      // Simulating: check --ignore some_dir specific_file.lua
      program.parse(["test-check", "--ignore", "some_dir", "specific_file.lua"], { from: "user" });

      expect(capturedPath).toBe("specific_file.lua");
      expect(capturedIgnore).toEqual(["some_dir"]);
    });
  });

  describe("Issue 5: --checklevel and --format validation", () => {
    it("rejects invalid --checklevel choice", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await runCLI(["check", ".", "--checklevel", "Bogus"]);
        expect(code).toBe(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringMatching(/--checklevel.*invalid|allowed choices/i)
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
          expect.stringMatching(/--format.*invalid|allowed choices/i)
        );
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe("Issue 6: UTF-8 BOM tolerance in config files", () => {
    it("parses JSONC text containing a leading UTF-8 BOM", () => {
      const bomJsonc = "\uFEFF{\n  \"diagnostics\": {\n    \"globals\": [\"MyGlobal\"]\n  }\n}";
      const parsed = parseJsonc<{ diagnostics: { globals: string[] } }>(bomJsonc);
      expect(parsed.diagnostics.globals).toEqual(["MyGlobal"]);
    });

    it("loads config file containing a leading UTF-8 BOM", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-bom-test-"));
      try {
        const configFile = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(configFile, "\uFEFF{\n  \"diagnostics\": { \"globals\": [\"BOMGlobal\"] }\n}", "utf-8");

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
        fs.writeFileSync(existingConfig, "{\"diagnostics\":{\"globals\":[\"KeepMe\"]}}", "utf-8");

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
      try {
        const existingConfig = path.join(tempDir, ".luarc.json");
        fs.writeFileSync(existingConfig, "{\"old\": true}", "utf-8");

        const created = initWorkspace(tempDir, { force: true });
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
          expect.stringMatching(/^error: Configuration file not found/i)
        );

        if (origDebug) process.env.DEBUG = origDebug;
      } finally {
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
        fs.writeFileSync(
          configPath,
          JSON.stringify({ files: { exclude: ["*.lua"] } }),
          "utf-8"
        );

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
        fs.writeFileSync(
          configPath,
          JSON.stringify({ files: { exclude: ["**/*.lua"] } }),
          "utf-8"
        );

        const count = countCheckedFiles(tempDir, configPath);
        expect(count).toBe(0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
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

  describe("Issue 4: --quiet suppresses progress output", () => {
    it("resolveLuaLSBinary with quiet=true suppresses [luals] console.log output", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await resolveLuaLSBinary("latest", { quiet: true });
        const calls = logSpy.mock.calls.map((c) => c.join(" "));
        const hasLualsLog = calls.some((msg) => msg.includes("[luals]"));
        expect(hasLualsLog).toBe(false);
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});

