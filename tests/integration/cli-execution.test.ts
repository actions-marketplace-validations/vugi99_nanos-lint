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
    expect(stdout).toMatch(/Diagnosis completed, no problems found across \d+ files?\./);
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

      // The launcher is referenced by its bare file name and resolved through the
      // `cwd` option, so no environment-derived absolute path is ever placed on a
      // command line interpreted by cmd.exe (CodeQL: js/shell-command-injection-from-environment).
      const cmdLauncher = "nanos-lint.cmd";

      // 1. Verify --help via .cmd
      const { stdout: helpStdout } = await execFileAsync("cmd.exe", ["/c", cmdLauncher, "--help"], {
        cwd: tempDir,
      });
      expect(helpStdout).toContain("Usage: nanos-lint");

      // 2. Verify -v via .cmd
      const { stdout: versionStdout } = await execFileAsync("cmd.exe", ["/c", cmdLauncher, "-v"], {
        cwd: tempDir,
      });
      expect(versionStdout.trim()).toMatch(/^nanos-lint v\d+\.\d+\.\d+$/);

      // 3. Verify failure exit code propagation via .cmd
      try {
        await execFileAsync(
          "cmd.exe",
          ["/c", cmdLauncher, "check", "tests/fail/type_mismatch.lua"],
          { cwd: rootDir }
        );
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

  it("preserves default ignore rules when --ignore is passed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-default-ignore-preserved-test-"));
    try {
      // Create a file inside `script/` which is in defaultIgnore
      fs.mkdirSync(path.join(tempDir, "script"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "script", "broken.lua"), "function invalid(");

      // 1. Without --ignore, defaultIgnore ignores `script/`, so 0 problems found
      const { stdout: stdoutDefault } = await execFileAsync(process.execPath, [distCli, "check", tempDir]);
      expect(stdoutDefault).toContain("Diagnosis completed, no problems found");

      // 2. With --ignore, default structural exclusions remain active, so `script/broken.lua` is still ignored
      const { stdout: stdoutIgnore } = await execFileAsync(process.execPath, [
        distCli,
        "check",
        tempDir,
        "--ignore",
        "unrelated_folder",
      ]);
      expect(stdoutIgnore).toContain("Diagnosis completed, no problems found");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("executes dist/cli.js clean-cache and clean subcommands in an isolated environment", async () => {
    const tempEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cli-clean-test-"));
    try {
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";

      let expectedCacheDir: string;
      if (isWindows) {
        expectedCacheDir = path.join(tempEnvDir, "nanos-lint", "Cache");
      } else if (isMac) {
        expectedCacheDir = path.join(tempEnvDir, "Library", "Caches", "nanos-lint");
      } else {
        expectedCacheDir = path.join(tempEnvDir, "cache", "nanos-lint");
      }

      // Pre-populate the cache directory
      fs.mkdirSync(expectedCacheDir, { recursive: true });
      fs.writeFileSync(path.join(expectedCacheDir, "test-binary"), "dummy content");
      expect(fs.existsSync(expectedCacheDir)).toBe(true);

      const isolatedEnv = {
        ...process.env,
        LOCALAPPDATA: tempEnvDir,
        XDG_CACHE_HOME: path.join(tempEnvDir, "cache"),
        HOME: tempEnvDir,
      };

      // 1. Run clean-cache
      const { stdout: stdoutClean } = await execFileAsync(
        process.execPath,
        [distCli, "clean-cache"],
        { env: isolatedEnv }
      );
      expect(stdoutClean).toContain("[cache] Cleared cache at:");
      expect(fs.existsSync(expectedCacheDir)).toBe(false);

      // 2. Run alias clean on already empty cache
      const { stdout: stdoutEmpty } = await execFileAsync(
        process.execPath,
        [distCli, "clean"],
        { env: isolatedEnv }
      );
      expect(stdoutEmpty).toContain("[cache] Cache is already empty");
    } finally {
      fs.rmSync(tempEnvDir, { recursive: true, force: true });
    }
  });

  it("executes dist/cli.js check with custom --annotations path", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-custom-ann-test-"));
    const annDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-ann-dir-"));
    try {
      const customAnn = path.join(annDir, "custom-annotations.lua");
      // Define a custom global function in the custom annotations file
      fs.writeFileSync(customAnn, "---@type fun(): void\nCustomSuperGlobal = nil\n", "utf-8");

      const script = path.join(tempDir, "script.lua");
      fs.writeFileSync(script, "CustomSuperGlobal()\n", "utf-8");

      // Running WITH --annotations customAnn must pass cleanly!
      const { stdout } = await execFileAsync(process.execPath, [
        distCli,
        "check",
        script,
        "--annotations",
        customAnn,
      ]);
      expect(stdout).toMatch(/Diagnosis completed, no problems found/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(annDir, { recursive: true, force: true });
    }
  });

  it("executes dist/cli.js check with custom NANOS_ANNOTATIONS_PATH environment variable", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-env-ann-test-"));
    const annDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-env-ann-dir-"));
    try {
      const customAnn = path.join(annDir, "custom-annotations.lua");
      fs.writeFileSync(customAnn, "---@type fun(): void\nEnvSuperGlobal = nil\n", "utf-8");

      const script = path.join(tempDir, "script.lua");
      fs.writeFileSync(script, "EnvSuperGlobal()\n", "utf-8");

      const { stdout } = await execFileAsync(process.execPath, [distCli, "check", script], {
        env: {
          ...process.env,
          NANOS_ANNOTATIONS_PATH: customAnn,
        },
      });
      expect(stdout).toMatch(/Diagnosis completed, no problems found/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(annDir, { recursive: true, force: true });
    }
  });
});


