import { describe, it, expect, vi } from "vitest";
import { runCLI } from "../../src/cli.js";

describe("cli module flag parsing", () => {
  it("prints help and returns 0 on --help", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI(["--help"]);
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("prints version and returns 0 on --version", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI(["--version"]);
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("warns on unrecognized flags", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Using --help will return immediately after parsing flags in loop
    await runCLI(["--formt=json", "--unknown-flag", "--help"]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unrecognized option '--formt=json'")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unrecognized option '--unknown-flag'")
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("warns when options requiring values are missing their values", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCLI(["--config", "--checklevel", "--format", "--luals-version", "--help"]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Option '--config' requires a value")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Option '--checklevel' requires a value")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Option '--format' requires a value")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Option '--luals-version' requires a value")
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});

