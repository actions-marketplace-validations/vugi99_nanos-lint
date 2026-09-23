import { describe, it, expect, vi } from "vitest";
import {
  escapePowerShellSingleQuote,
  resolveLatestLuaLSVersion,
  resolveLuaLSVersion,
  sanitizeLuaLSVersion,
  FALLBACK_LUALS_VERSION,
  countCheckedFiles,
  getPlatformInfo,
  resolveLuaLSBinary,
  findExistingLuaLSDir,
  isBinaryValid,
  runLuaLSCheck,
  downloadAndExtractLuaLS,
  getLegacyCacheDir,
  getCacheDir,
} from "../../src/luals.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

describe("luals utilities", () => {
  it("escapes single quotes correctly for PowerShell single-quoted commands", () => {
    expect(escapePowerShellSingleQuote("C:\\Users\\John O'Connor\\AppData")).toBe(
      "C:\\Users\\John O''Connor\\AppData"
    );
    expect(escapePowerShellSingleQuote("normal_path/without/quotes")).toBe(
      "normal_path/without/quotes"
    );
    expect(escapePowerShellSingleQuote("a'b'c'd")).toBe("a''b''c''d");
  });

  it("handles GitHub API timeout or failure gracefully with fallback version", async () => {
    // Mock fetch to simulate network timeout / abort error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Timeout"));

    try {
      const version = await resolveLatestLuaLSVersion();
      expect(version).toBe(FALLBACK_LUALS_VERSION);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe("sanitizeLuaLSVersion", () => {
    it("accepts plain release tags and strips a leading v", () => {
      expect(sanitizeLuaLSVersion("3.19.1")).toBe("3.19.1");
      expect(sanitizeLuaLSVersion("v3.19.1")).toBe("3.19.1");
      expect(sanitizeLuaLSVersion("  3.19.1  ")).toBe("3.19.1");
      expect(sanitizeLuaLSVersion("3.19.1-nightly.2")).toBe("3.19.1-nightly.2");
      expect(sanitizeLuaLSVersion("V3")).toBe("V3");
      expect(sanitizeLuaLSVersion("alpha.1")).toBe("alpha.1");
    });

    it("rejects values that could escape the cache directory", () => {
      expect(sanitizeLuaLSVersion("../../etc")).toBeNull();
      expect(sanitizeLuaLSVersion("..")).toBeNull();
      expect(sanitizeLuaLSVersion(".")).toBeNull();
      expect(sanitizeLuaLSVersion("3.19.1/../../evil")).toBeNull();
      expect(sanitizeLuaLSVersion("C:\\Windows\\System32\\evil")).toBeNull();
      expect(sanitizeLuaLSVersion("3.19.1; rm -rf /")).toBeNull();
      expect(sanitizeLuaLSVersion("3.19.1$(whoami)")).toBeNull();
      expect(sanitizeLuaLSVersion("")).toBeNull();
      expect(sanitizeLuaLSVersion("   ")).toBeNull();
      expect(sanitizeLuaLSVersion("v")).toBeNull();
      expect(sanitizeLuaLSVersion("-3.19.1")).toBeNull();
      expect(sanitizeLuaLSVersion("a".repeat(65))).toBeNull();
    });

    it("treats a malicious GitHub API tag name as unparsable and uses the fallback", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ tag_name: "v../../../../tmp/evil" }),
      });

      try {
        await expect(resolveLatestLuaLSVersion()).resolves.toBe(FALLBACK_LUALS_VERSION);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("uses a valid GitHub API tag name", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ tag_name: "v3.20.0" }),
      });

      try {
        await expect(resolveLatestLuaLSVersion()).resolves.toBe("3.20.0");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("rejects an explicitly requested invalid version", async () => {
      await expect(resolveLuaLSVersion("../../evil")).rejects.toThrow(/Invalid LuaLS version/);
      await expect(resolveLuaLSVersion("3.19.1 && whoami")).rejects.toThrow(
        /Invalid LuaLS version/
      );
    });

    it("accepts an explicitly requested valid version", async () => {
      await expect(resolveLuaLSVersion("v3.19.1")).resolves.toBe("3.19.1");
    });
  });

  describe("countCheckedFiles helper", () => {
    it("counts single lua file correctly", () => {
      const singleFile = path.resolve(__dirname, "../../tests/pass/character.lua");
      expect(countCheckedFiles(singleFile)).toBe(1);
    });

    it("counts lua files in directory correctly", () => {
      const passDir = path.resolve(__dirname, "../../tests/pass");
      expect(countCheckedFiles(passDir)).toBe(3);
    });

    it("returns 0 for non-existent path", () => {
      expect(countCheckedFiles("non_existent_path_xyz")).toBe(0);
    });
  });

  describe("getPlatformInfo and resolveLuaLSBinary overrides", () => {
    it("respects process.env.LUALS_BIN override when file exists", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "luals-override-"));
      try {
        const dummyBin = path.join(tempDir, "fake-luals");
        fs.writeFileSync(dummyBin, "mock binary");
        process.env.LUALS_BIN = dummyBin;

        const resolved = await resolveLuaLSBinary("3.13.6");
        expect(resolved).toBe(dummyBin);
      } finally {
        delete process.env.LUALS_BIN;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("evaluates platform and architecture combinations in getPlatformInfo", () => {
      const origPlatform = process.platform;
      const origArch = process.arch;

      try {
        // Darwin arm64 and x64
        Object.defineProperty(process, "platform", { value: "darwin" });
        Object.defineProperty(process, "arch", { value: "arm64" });
        expect(getPlatformInfo("3.13.6").assetName).toContain("darwin-arm64");

        Object.defineProperty(process, "arch", { value: "x64" });
        expect(getPlatformInfo("3.13.6").assetName).toContain("darwin-x64");

        // Linux arm64, x64, unsupported
        Object.defineProperty(process, "platform", { value: "linux" });
        Object.defineProperty(process, "arch", { value: "arm64" });
        expect(getPlatformInfo("3.13.6").assetName).toContain("linux-arm64");

        Object.defineProperty(process, "arch", { value: "x64" });
        expect(getPlatformInfo("3.13.6").assetName).toContain("linux-x64");

        Object.defineProperty(process, "arch", { value: "ia32" });
        expect(() => getPlatformInfo("3.13.6")).toThrow(/Unsupported Linux architecture/);

        // Windows x64 vs unsupported
        Object.defineProperty(process, "platform", { value: "win32" });
        Object.defineProperty(process, "arch", { value: "x64" });
        expect(getPlatformInfo("3.13.6").assetName).toContain("win32-x64");

        Object.defineProperty(process, "arch", { value: "arm" });
        expect(() => getPlatformInfo("3.13.6")).toThrow(/Unsupported Windows architecture/);

        // Unsupported OS
        Object.defineProperty(process, "platform", { value: "sunos" });
        expect(() => getPlatformInfo("3.13.6")).toThrow(/Unsupported platform: sunos/);
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform });
        Object.defineProperty(process, "arch", { value: origArch });
      }
    });

    it("handles resolveLatestLuaLSVersion with GITHUB_TOKEN and invalid status", async () => {
      const origToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "ghp_luals_token";
      const originalFetch = globalThis.fetch;

      let capturedHeaders: Record<string, string> | undefined;
      globalThis.fetch = vi.fn().mockImplementation((_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ tag_name: "v3.13.6" }),
        } as unknown as Response);
      });

      try {
        const ver = await resolveLatestLuaLSVersion();
        expect(ver).toBe("3.13.6");
        expect(capturedHeaders?.["Authorization"]).toBe("token ghp_luals_token");

        // When res.ok is false
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
          ok: false,
          status: 500,
        } as unknown as Response);
        const fallback = await resolveLatestLuaLSVersion();
        expect(fallback).toBe(FALLBACK_LUALS_VERSION);
      } finally {
        if (origToken !== undefined) {
          process.env.GITHUB_TOKEN = origToken;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("findExistingLuaLSDir", () => {
    it("returns null for non-existent versions", () => {
      const result = findExistingLuaLSDir("0.0.0-nonexistent");
      expect(result).toBeNull();
    });

    it("returns primary cache directory when valid binary and marker exist", () => {
      const result = findExistingLuaLSDir("3.19.1");
      // Since 3.19.1 was pre-resolved/cached, it should return a string path if present
      if (result !== null) {
        expect(typeof result).toBe("string");
        expect(fs.existsSync(result)).toBe(true);
      }
    });

    it("returns legacy cache directory when legacy binary and marker exist", async () => {
      const cachedDir = findExistingLuaLSDir("3.19.1");
      if (!cachedDir) {
        return;
      }
      const tempLegacyBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-legacy-base-"));
      const testVersion = "9.8.7";
      const legacyDir = path.join(tempLegacyBase, "nanos-lint", "luals", testVersion);
      fs.mkdirSync(path.dirname(legacyDir), { recursive: true });
      fs.cpSync(cachedDir, legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, ".complete"), testVersion);

      const origLocal = process.env.LOCALAPPDATA;
      const origXdg = process.env.XDG_CACHE_HOME;
      if (process.platform === "win32") {
        process.env.LOCALAPPDATA = tempLegacyBase;
      } else {
        process.env.XDG_CACHE_HOME = tempLegacyBase;
      }

      const primaryTestCache = getCacheDir(testVersion);
      if (fs.existsSync(primaryTestCache)) {
        fs.rmSync(primaryTestCache, { recursive: true, force: true });
      }

      try {
        const found = findExistingLuaLSDir(testVersion);
        expect(found).toBe(legacyDir);

        const resolved = await resolveLuaLSBinary(testVersion, { quiet: true });
        expect(typeof resolved).toBe("string");
        expect(fs.existsSync(resolved)).toBe(true);
      } finally {
        if (origLocal !== undefined) {
          process.env.LOCALAPPDATA = origLocal;
        } else {
          delete process.env.LOCALAPPDATA;
        }
        if (origXdg !== undefined) {
          process.env.XDG_CACHE_HOME = origXdg;
        } else {
          delete process.env.XDG_CACHE_HOME;
        }
        fs.rmSync(tempLegacyBase, { recursive: true, force: true });
        if (fs.existsSync(primaryTestCache)) {
          fs.rmSync(primaryTestCache, { recursive: true, force: true });
        }
      }
    });
  });

  describe("isBinaryValid", () => {
    it("returns false for non-existent path", () => {
      expect(isBinaryValid("/path/to/nonexistent/bin")).toBe(false);
    });

    it("returns false for a file that is too small or not a file", () => {
      const tempSmallFile = path.join(os.tmpdir(), `test-small-${Date.now()}.bin`);
      fs.writeFileSync(tempSmallFile, "short content");
      try {
        expect(isBinaryValid(tempSmallFile)).toBe(false);
        expect(isBinaryValid(os.tmpdir())).toBe(false);
      } finally {
        fs.unlinkSync(tempSmallFile);
      }
    });

    it("returns false when file is large enough but execFileSync fails", () => {
      const tempFakeBin = path.join(os.tmpdir(), `test-fake-large-${Date.now()}.exe`);
      fs.writeFileSync(tempFakeBin, Buffer.alloc(100_005));
      try {
        expect(isBinaryValid(tempFakeBin)).toBe(false);
      } finally {
        fs.unlinkSync(tempFakeBin);
      }
    });
  });

  describe("countCheckedFiles", () => {
    it("returns 0 for non-existent path", () => {
      expect(countCheckedFiles("/nonexistent/path/for/counting")).toBe(0);
    });

    it("returns 1 for a single .lua file and 0 for non-lua file", () => {
      const tempLua = path.join(os.tmpdir(), `test-${Date.now()}.lua`);
      const tempTxt = path.join(os.tmpdir(), `test-${Date.now()}.txt`);
      fs.writeFileSync(tempLua, "print('hi')");
      fs.writeFileSync(tempTxt, "hello");
      try {
        expect(countCheckedFiles(tempLua)).toBe(1);
        expect(countCheckedFiles(tempTxt)).toBe(0);
      } finally {
        fs.unlinkSync(tempLua);
        fs.unlinkSync(tempTxt);
      }
    });

    it("handles corrupted configPath gracefully without throwing", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-count-test-"));
      const badConfig = path.join(tempDir, ".luarc.json");
      fs.writeFileSync(badConfig, "{ invalid json");
      fs.writeFileSync(path.join(tempDir, "script.lua"), "local a = 1");
      try {
        const count = countCheckedFiles(tempDir, badConfig);
        expect(count).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("applies excludePatterns with globs and handles pattern matching", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-glob-test-"));
      const config = path.join(tempDir, ".luarc.json");
      fs.writeFileSync(
        config,
        JSON.stringify({
          files: {
            exclude: ["ignored/**", "vendor/*.lua", "temp-?.lua", "*.bak", "**/nested/*.lua", "build/**"],
          },
        })
      );
      fs.mkdirSync(path.join(tempDir, "ignored"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "ignored", "sub.lua"), "a=1");
      fs.mkdirSync(path.join(tempDir, "vendor"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "vendor", "lib.lua"), "a=1");
      fs.writeFileSync(path.join(tempDir, "temp-1.lua"), "a=1");
      fs.writeFileSync(path.join(tempDir, "test.bak"), "a=1");
      fs.mkdirSync(path.join(tempDir, "deep", "nested"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "deep", "nested", "deep.lua"), "a=1");
      fs.mkdirSync(path.join(tempDir, "build"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "build", "output.lua"), "a=1");
      fs.writeFileSync(path.join(tempDir, "keep.lua"), "a=1");

      try {
        const count = countCheckedFiles(tempDir, config);
        expect(count).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("resolveLuaLSBinary", () => {
    it("respects LUALS_BIN environment variable when pointing to valid file", async () => {
      const origBin = process.env.LUALS_BIN;
      const tempBin = path.join(os.tmpdir(), `fake-luals-${Date.now()}.exe`);
      fs.writeFileSync(tempBin, "binary");
      process.env.LUALS_BIN = tempBin;
      try {
        const resolved = await resolveLuaLSBinary();
        expect(resolved).toBe(tempBin);
      } finally {
        if (origBin !== undefined) {
          process.env.LUALS_BIN = origBin;
        } else {
          delete process.env.LUALS_BIN;
        }
        fs.unlinkSync(tempBin);
      }
    });
  });

  describe("runLuaLSCheck", () => {
    it("throws if targetPath does not exist", async () => {
      await expect(
        runLuaLSCheck("/nonexistent/target/path", "dummy-config.json", {
          path: "/nonexistent/target/path",
          checklevel: "Warning",
          lualsVersion: "3.19.1",
        })
      ).rejects.toThrow(/Target path does not exist/);
    });

    it("runs check on a single file with checklevel and filters diagnostics", async () => {
      const emptyLua = path.resolve("tests/pass/empty.lua");
      const config = path.resolve("templates/default.luarc.json");
      if (fs.existsSync(emptyLua) && fs.existsSync(config)) {
        const result = await runLuaLSCheck(emptyLua, config, {
          path: emptyLua,
          checklevel: "Error",
          lualsVersion: "3.19.1",
        });
        expect(result.passed).toBe(true);
        expect(result.totalErrors).toBe(0);
      }
    });

    it("runs check on a failing file without checklevel and counts warnings and problem files", async () => {
      const failLua = path.resolve("tests/fail/type_mismatch.lua");
      const config = path.resolve("templates/default.luarc.json");
      if (fs.existsSync(failLua) && fs.existsSync(config)) {
        const result = await runLuaLSCheck(failLua, config, {
          path: failLua,
          lualsVersion: "3.19.1",
        });
        expect(result.passed).toBe(false);
        expect(result.totalProblems).toBeGreaterThan(0);
        expect(result.totalFiles).toBe(1);
      }
    });

    it("resolves cached binary when available without redownloading", async () => {
      const existing = findExistingLuaLSDir("3.19.1");
      if (existing) {
        const binary = await resolveLuaLSBinary("3.19.1", { quiet: true });
        expect(typeof binary).toBe("string");
        expect(fs.existsSync(binary)).toBe(true);
      }
    });

    it("ignores default ignoreDirs such as .git, .vscode, and node_modules", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-ignored-dirs-"));
      fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "hook.lua"), "a=1");
      fs.mkdirSync(path.join(tempDir, ".vscode"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".vscode", "settings.lua"), "a=1");
      fs.mkdirSync(path.join(tempDir, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "node_modules", "pkg.lua"), "a=1");
      fs.writeFileSync(path.join(tempDir, "valid.lua"), "a=1");

      try {
        const count = countCheckedFiles(tempDir);
        expect(count).toBe(1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("downloadAndExtractLuaLS", () => {
    it("logs progress when quiet is false when reusing existing installation, and returns immediately if complete", async () => {
      const existing = findExistingLuaLSDir("3.19.1");
      if (existing) {
        const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-download-quiet-"));
        try {
          const bin = await downloadAndExtractLuaLS("3.19.1", tempTarget, { quiet: false });
          expect(fs.existsSync(bin)).toBe(true);

          // Second invocation on already complete directory returns immediately
          const bin2 = await downloadAndExtractLuaLS("3.19.1", tempTarget, { quiet: false });
          expect(bin2).toBe(bin);
        } finally {
          fs.rmSync(tempTarget, { recursive: true, force: true });
        }
      }
    });
  });

  describe("getLegacyCacheDir", () => {
    it("handles environment variables and fallback paths", () => {
      const origLocal = process.env.LOCALAPPDATA;
      const origXdg = process.env.XDG_CACHE_HOME;
      try {
        delete process.env.LOCALAPPDATA;
        const dir1 = getLegacyCacheDir("3.19.1");
        expect(typeof dir1).toBe("string");

        process.env.LOCALAPPDATA = "C:\\CustomLocal";
        const dir2 = getLegacyCacheDir("3.19.1");
        if (process.platform === "win32") {
          expect(dir2).toContain("CustomLocal");
        }
      } finally {
        if (origLocal !== undefined) process.env.LOCALAPPDATA = origLocal;
        else delete process.env.LOCALAPPDATA;
        if (origXdg !== undefined) process.env.XDG_CACHE_HOME = origXdg;
        else delete process.env.XDG_CACHE_HOME;
      }
    });
  });
});


