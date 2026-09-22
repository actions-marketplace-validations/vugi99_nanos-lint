import { describe, it, expect, beforeAll } from "vitest";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const rootDir = path.resolve(__dirname, "../..");
const distCli = path.join(rootDir, "dist", "cli.js");
const binCli = path.join(rootDir, "bin", "nanos-lint.js");

describe("CLI entrypoint execution regression tests", () => {
  beforeAll(async () => {
    if (!fs.existsSync(distCli)) {
      await execAsync("npm run build", { cwd: rootDir });
    }
  }, 30000);

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

  it("executes with no arguments inside a directory containing LuaLS without hanging", async () => {
    // Regression test for issue where running `nanos-lint` with no arguments
    // inside the release folder would hang analyzing LuaLS internal scripts
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-release-hang-test-"));
    try {
      // Mock LuaLS standalone layout
      fs.writeFileSync(path.join(tempDir, "main.lua"), "-- dummy main.lua");
      fs.mkdirSync(path.join(tempDir, "bin"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "bin", "lua-language-server.exe"), "");
      fs.mkdirSync(path.join(tempDir, "script"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "script", "dummy.lua"), "-- dummy script");

      const { stdout } = await execFileAsync(process.execPath, [distCli], {
        cwd: tempDir,
        timeout: 10000,
      });

      expect(stdout).toContain("Diagnosis completed, no problems found");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("executes with --ignore pattern matching (myfolder/hello-*.lua)", async () => {
    const fixtureDir = path.join(rootDir, "tests", "fixtures", "ignore_test");
    try {
      await execFileAsync(process.execPath, [
        distCli,
        "check",
        fixtureDir,
        "--ignore",
        "myfolder/hello-*.lua",
      ]);
      expect.fail("Expected check to fail because other.lua still has an error");
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string };
      expect(execErr.code).toBe(1);
      expect(execErr.stdout).toContain("other.lua");
      expect(execErr.stdout).not.toContain("hello-1.lua");
      expect(execErr.stdout).not.toContain("hello-2.lua");
      expect(execErr.stdout).toContain("2 problems (2 errors) found across 1 file.");
    }
  });

  it("executes with multiple --ignore rules and exits cleanly", async () => {
    const fixtureDir = path.join(rootDir, "tests", "fixtures", "ignore_test");
    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      fixtureDir,
      "--ignore",
      "myfolder/hello-*.lua",
      "-i",
      "myfolder/other.lua",
    ]);

    expect(stdout).toContain("Diagnosis completed, no problems found");
  });

  it("executes with directory --ignore rule and exits cleanly", async () => {
    const fixtureDir = path.join(rootDir, "tests", "fixtures", "ignore_test");
    const { stdout } = await execFileAsync(process.execPath, [
      distCli,
      "check",
      fixtureDir,
      "--ignore",
      "myfolder",
    ]);

    expect(stdout).toContain("Diagnosis completed, no problems found");
  });

  it("does not use hardcoded ignore rules when --ignore is passed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-hardcoded-bypass-test-"));
    try {
      // Create a file inside `script/` which is in defaultIgnore
      fs.mkdirSync(path.join(tempDir, "script"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "script", "broken.lua"), "function invalid(");

      // 1. Without --ignore, defaultIgnore ignores `script/`, so 0 problems found
      const { stdout: stdoutDefault } = await execFileAsync(process.execPath, [distCli, "check", tempDir]);
      expect(stdoutDefault).toContain("Diagnosis completed, no problems found");

      // 2. With --ignore, hardcoded ignore rules are bypassed, so `script/broken.lua` is analyzed
      try {
        await execFileAsync(process.execPath, [
          distCli,
          "check",
          tempDir,
          "--ignore",
          "unrelated_folder",
        ]);
        expect.fail("Expected check to fail because script/ is not ignored when custom --ignore is passed");
      } catch (err: unknown) {
        const execErr = err as { code?: number; stdout?: string };
        expect(execErr.code).toBe(1);
        expect(execErr.stdout).toContain("broken.lua");
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

