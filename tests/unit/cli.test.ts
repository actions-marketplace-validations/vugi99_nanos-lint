import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { runCLI } from "../../src/cli.js";

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
});
