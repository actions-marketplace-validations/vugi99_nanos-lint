import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { runCLI, isDirectExecution, collectIgnorePatterns } from "../../src/cli.js";

describe("cli module flag and command parsing", () => {
  it("prints help and returns 0 on --help and -h", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code1 = await runCLI(["--help"]);
    expect(code1).toBe(0);
    expect(spy).toHaveBeenCalled();

    const code2 = await runCLI(["-h"]);
    expect(code2).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("prints version and returns 0 on --version and -v", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code1 = await runCLI(["--version"]);
    expect(code1).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/nanos-lint v\d+\.\d+\.\d+/));

    const code2 = await runCLI(["-v"]);
    expect(code2).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/nanos-lint v\d+\.\d+\.\d+/));
    spy.mockRestore();
  });

  it("handles help and version subcommands", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const helpCode = await runCLI(["help"]);
    expect(helpCode).toBe(0);

    const versionCode = await runCLI(["version"]);
    expect(versionCode).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/nanos-lint v\d+\.\d+\.\d+/));
    spy.mockRestore();
  });

  it("errors on unrecognized flags and returns 1", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI(["--unknown-flag"]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown option '--unknown-flag'")
    );

    errSpy.mockRestore();
  });

  it("errors when options requiring values are missing their values and returns 1", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const codeConfig = await runCLI(["--config"]);
    expect(codeConfig).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("option '--config <path>' argument missing")
    );

    const codeChecklevel = await runCLI(["--checklevel"]);
    expect(codeChecklevel).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("option '--checklevel <level>' argument missing")
    );

    errSpy.mockRestore();
  });

  it("executes init subcommand successfully", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cli-init-test-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const code = await runCLI(["init", tempDir]);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(tempDir, ".luarc.json"))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      logSpy.mockRestore();
    }
  });

  describe("collectIgnorePatterns helper", () => {
    it("handles single pattern", () => {
      expect(collectIgnorePatterns("myfolder/hello-*.lua")).toEqual(["myfolder/hello-*.lua"]);
    });

    it("handles comma-separated patterns", () => {
      expect(collectIgnorePatterns("myfolder/hello-*.lua, vendor/**, dist")).toEqual([
        "myfolder/hello-*.lua",
        "vendor/**",
        "dist",
      ]);
    });

    it("handles newline-separated patterns", () => {
      const multiline = `
        myfolder/hello-*.lua
        temp/*
        vendor
      `;
      expect(collectIgnorePatterns(multiline)).toEqual([
        "myfolder/hello-*.lua",
        "temp/*",
        "vendor",
      ]);
    });

    it("accumulates across multiple calls", () => {
      const first = collectIgnorePatterns("pat1, pat2");
      const second = collectIgnorePatterns("pat3", first);
      expect(second).toEqual(["pat1", "pat2", "pat3"]);
    });
  });

  describe("isDirectExecution entrypoint detection", () => {
    it("returns false when argv[1] is undefined", () => {
      expect(isDirectExecution(import.meta.url, undefined)).toBe(false);
    });

    it("returns true when argv[1] matches module path exactly", () => {
      const fakeFile = path.resolve("/workspace/dist/cli.js");
      const fakeUrl = pathToFileURL(fakeFile).href;
      expect(isDirectExecution(fakeUrl, fakeFile)).toBe(true);
    });

    it("returns true when argv[1] points to cli.js or cli.ts in the same directory as a bundled chunk", () => {
      const chunkFile = path.resolve("/workspace/dist/cli-xyz123.js");
      const chunkUrl = pathToFileURL(chunkFile).href;
      const cliJsArgv = path.resolve("/workspace/dist/cli.js");
      const cliTsArgv = path.resolve("/workspace/dist/cli.ts");
      expect(isDirectExecution(chunkUrl, cliJsArgv)).toBe(true);
      expect(isDirectExecution(chunkUrl, cliTsArgv)).toBe(true);
    });

    it("returns false when argv[1] points to a different script or parent runner", () => {
      const chunkFile = path.resolve("/workspace/dist/cli-xyz123.js");
      const chunkUrl = pathToFileURL(chunkFile).href;
      const binArgv = path.resolve("/workspace/bin/nanos-lint.js");
      const userScript = path.resolve("/workspace/my-app/index.js");
      expect(isDirectExecution(chunkUrl, binArgv)).toBe(false);
      expect(isDirectExecution(chunkUrl, userScript)).toBe(false);
    });
  });
});

