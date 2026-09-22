import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(__dirname, "../..");
const distCli = path.join(rootDir, "dist", "cli.js");
const binCli = path.join(rootDir, "bin", "nanos-lint.js");

describe("CLI entrypoint execution regression tests", () => {
  it("executes dist/cli.js --help directly and outputs non-empty help text", async () => {
    expect(fs.existsSync(distCli), "dist/cli.js must be built").toBe(true);

    const { stdout, stderr } = await execFileAsync(process.execPath, [distCli, "--help"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: nanos-lint");
    expect(stdout).toContain("Check a workspace or Lua file");
    expect(stdout.trim().length).toBeGreaterThan(50);
  });

  it("executes dist/cli.js -v directly and outputs version string", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [distCli, "-v"]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toMatch(/^nanos-lint v\d+\.\d+\.\d+$/);
  });

  it("executes dist/cli.js check tests/pass directly and exits with code 0", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      path.join(rootDir, "tests", "pass"),
    ]);
    expect(stdout).toContain("Diagnosis completed, no problems found");
  });

  it("executes dist/cli.js check tests/fail/type_mismatch.lua directly and exits with code 1", async () => {
    try {
      await execFileAsync(process.execPath, [
        distCli,
        "check",
        path.join(rootDir, "tests", "fail", "type_mismatch.lua"),
      ]);
      expect.fail("Expected dist/cli.js to exit with non-zero code on type_mismatch.lua");
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string; stderr?: string };
      expect(execErr.code).toBe(1);
      expect(execErr.stdout).toContain("param-type-mismatch");
    }
  });

  it("executes bin/nanos-lint.js --help and matches dist/cli.js output", async () => {
    const { stdout: binStdout } = await execFileAsync(process.execPath, [binCli, "--help"]);
    const { stdout: distStdout } = await execFileAsync(process.execPath, [distCli, "--help"]);

    expect(binStdout.trim()).toBe(distStdout.trim());
  });

  it("executes via Windows batch launcher (.cmd) and propagates output and exit codes", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cmd-test-"));
    const tempCmd = path.join(tempDir, "nanos-lint.cmd");

    try {
      // Replicate the exact release .cmd launcher script
      fs.writeFileSync(
        tempCmd,
        `@echo off\r\nnode "${distCli}" %*\r\nexit /b %ERRORLEVEL%\r\n`
      );

      // 1. Verify --help via .cmd
      const { stdout: helpStdout } = await execFileAsync("cmd.exe", ["/c", tempCmd, "--help"]);
      expect(helpStdout).toContain("Usage: nanos-lint");

      // 2. Verify -v via .cmd
      const { stdout: versionStdout } = await execFileAsync("cmd.exe", ["/c", tempCmd, "-v"]);
      expect(versionStdout.trim()).toMatch(/^nanos-lint v\d+\.\d+\.\d+$/);

      // 3. Verify failure exit code propagation via .cmd
      try {
        await execFileAsync("cmd.exe", [
          "/c",
          tempCmd,
          "check",
          path.join(rootDir, "tests", "fail", "type_mismatch.lua"),
        ]);
        expect.fail("Expected .cmd launcher to propagate exit code 1");
      } catch (err: unknown) {
        const execErr = err as { code?: number };
        expect(execErr.code).toBe(1);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

