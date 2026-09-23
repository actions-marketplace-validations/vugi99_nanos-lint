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
  limitDownloadStream,
  isAllowedDownloadUrl,
  computeFileSha256,
  getLegacyCacheDir,
} from "../../src/luals.js";
import { resolveWorkspaceConfig } from "../../src/config.js";
import { fileUriToPath } from "../../src/types.js";
import {
  getSharedAnnotations,
  getSharedLuaLSBinary,
  isLiveTestsEnabled,
  seedCachedLuaLS,
} from "../helpers/live.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Readable } from "node:stream";

const liveTestsEnabled = isLiveTestsEnabled();

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
      const baseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-find-empty-"));
      try {
        expect(findExistingLuaLSDir("0.0.0-nonexistent", baseCacheDir)).toBeNull();
      } finally {
        fs.rmSync(baseCacheDir, { recursive: true, force: true });
      }
    });

    it.skipIf(!liveTestsEnabled)("returns the primary cache directory when a valid binary and marker exist", async () => {
      const baseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-find-primary-"));
      try {
        const seeded = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
        const expectedDir = path.resolve(seeded, "..", "..");
        expect(findExistingLuaLSDir(FALLBACK_LUALS_VERSION, baseCacheDir)).toBe(expectedDir);
      } finally {
        fs.rmSync(baseCacheDir, { recursive: true, force: true });
      }
    });

    it.skipIf(!liveTestsEnabled)("returns the legacy cache directory and migrates it into the primary cache", async () => {
      const version = "9.8.7";
      const legacyBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-legacy-base-"));
      const primaryBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-legacy-primary-"));
      const origLocal = process.env.LOCALAPPDATA;
      const origXdg = process.env.XDG_CACHE_HOME;

      try {
        const legacyVersionsDir = path.join(legacyBase, "nanos-lint", "luals");
        await seedCachedLuaLS(legacyVersionsDir, version);
        const legacyDir = path.join(legacyVersionsDir, version);

        if (process.platform === "win32") {
          process.env.LOCALAPPDATA = legacyBase;
        } else {
          process.env.XDG_CACHE_HOME = legacyBase;
        }

        expect(findExistingLuaLSDir(version, primaryBase)).toBe(legacyDir);

        // Migrated into the requested primary cache instead of re-downloaded.
        const resolved = await resolveLuaLSBinary(version, { quiet: true, cacheDir: primaryBase });
        const info = getPlatformInfo(version);
        const migratedBin = path.join(primaryBase, version, info.binaryRelativePath);

        expect(resolved).toBe(migratedBin);
        expect(fs.existsSync(migratedBin)).toBe(true);
        expect(fs.readFileSync(path.join(primaryBase, version, ".complete"), "utf-8")).toBe(version);
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
        fs.rmSync(legacyBase, { recursive: true, force: true });
        fs.rmSync(primaryBase, { recursive: true, force: true });
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

    it.skipIf(!isLiveTestsEnabled())(
      "runs check on a single file with checklevel and filters diagnostics to that file",
      async () => {
        const passFile = path.resolve("tests/pass/character.lua");
        expect(fs.existsSync(passFile), "tests/pass/character.lua fixture must exist").toBe(true);

        const resolved = resolveWorkspaceConfig(path.dirname(passFile), undefined, {
          annotationsPath: await getSharedAnnotations(),
        });
        try {
          const result = await runLuaLSCheck(passFile, resolved.configPath, {
            path: passFile,
            checklevel: "Warning",
            lualsBin: await getSharedLuaLSBinary(),
          });
          expect(result.passed).toBe(true);
          expect(result.totalErrors).toBe(0);
          expect(result.totalFiles).toBe(1);
        } finally {
          if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
            fs.unlinkSync(resolved.configPath);
          }
        }
      }
    );

    it.skipIf(!isLiveTestsEnabled())(
      "runs check on a failing file without checklevel and counts warnings and problem files",
      async () => {
        const failFile = path.resolve("tests/fail/type_mismatch.lua");
        expect(fs.existsSync(failFile), "tests/fail/type_mismatch.lua fixture must exist").toBe(true);

        const resolved = resolveWorkspaceConfig(path.dirname(failFile), undefined, {
          annotationsPath: await getSharedAnnotations(),
        });
        try {
          const result = await runLuaLSCheck(failFile, resolved.configPath, {
            path: failFile,
            lualsBin: await getSharedLuaLSBinary(),
          });
          expect(result.passed).toBe(false);
          expect(result.totalProblems).toBeGreaterThan(0);
          expect(result.totalFiles).toBe(1);
          // Only this file's diagnostics survive; compare like runLuaLSCheck().
          for (const uri of Object.keys(result.diagnostics)) {
            expect(path.resolve(fileUriToPath(uri)).toLowerCase()).toBe(
              path.resolve(failFile).toLowerCase()
            );
          }
        } finally {
          if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
            fs.unlinkSync(resolved.configPath);
          }
        }
      }
    );

    it.skipIf(!liveTestsEnabled)("resolves an explicitly requested version from an injected cache without downloading", async () => {
      const baseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-explicit-cache-"));
      try {
        const seeded = await seedCachedLuaLS(baseCacheDir, "3.19.1");
        const binary = await resolveLuaLSBinary("3.19.1", { quiet: true, cacheDir: baseCacheDir });
        expect(binary).toBe(seeded);
        expect(fs.existsSync(binary)).toBe(true);
      } finally {
        fs.rmSync(baseCacheDir, { recursive: true, force: true });
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
    it.skipIf(!isLiveTestsEnabled())(
      "reuses an existing installation, logs progress when quiet is false, and returns immediately when complete",
      async () => {
        const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-download-quiet-"));
        try {
          const bin = await downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, tempTarget, {
            quiet: false,
          });
          expect(fs.existsSync(bin)).toBe(true);
          expect(fs.existsSync(path.join(tempTarget, ".complete"))).toBe(true);

          // Second invocation on an already complete directory returns immediately
          const bin2 = await downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, tempTarget, {
            quiet: false,
          });
          expect(bin2).toBe(bin);
        } finally {
          fs.rmSync(tempTarget, { recursive: true, force: true });
        }
      }
    );

    it("handles download failure when fetch rejects", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-dl-fail-"));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network connection error"));
      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false })
        ).rejects.toThrow(/Failed to download LuaLS/);
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("throws LuaLSError when response body is null", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-dl-nobody-"));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: null,
      } as unknown as Response);
      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false })
        ).rejects.toThrow(/Failed to download LuaLS/);
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("enforces Content-Length upper bound on archive download (Issue #18)", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-download-bound-"));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-length": "200000000" }),
        body: {
          cancel: vi.fn(),
        },
      } as unknown as Response);
      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false })
        ).rejects.toThrow(/exceeds maximum limit/);
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("passes AbortSignal timeout to fetch during archive download (Issue #18)", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-download-sig-"));
      const originalFetch = globalThis.fetch;
      let capturedSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal;
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Error",
          body: { cancel: vi.fn() },
        } as unknown as Response);
      });
      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false })
        ).rejects.toThrow();
        expect(capturedSignal).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("rejects download when stream chunks exceed maximum size limit (Issue #18)", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-download-stream-limit-"));
      const originalFetch = globalThis.fetch;
      const bigChunk = Buffer.alloc(1024 * 1024); // 1 MB
      let count = 0;
      const stream = new Readable({
        read() {
          if (count++ < 160) {
            this.push(bigChunk);
          } else {
            this.push(null);
          }
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: stream,
      } as unknown as Response);
      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false })
        ).rejects.toThrow(/exceeded maximum allowed size/);
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("limitDownloadStream yields chunks when under size limit (Issue #18)", async () => {
      async function* generate() {
        yield Buffer.from("chunk1");
        yield Buffer.from("chunk2");
      }
      const collected: Buffer[] = [];
      for await (const chunk of limitDownloadStream(generate())) {
        collected.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(collected).toString()).toBe("chunk1chunk2");
    });

    it("isAllowedDownloadUrl validates HTTPS GitHub domains correctly (Issue #19)", () => {
      expect(isAllowedDownloadUrl("https://github.com/LuaLS/releases")).toBe(true);
      expect(isAllowedDownloadUrl("https://objects.githubusercontent.com/asset.tar.gz")).toBe(true);
      expect(isAllowedDownloadUrl("https://release-assets.githubusercontent.com/asset.zip")).toBe(true);
      expect(isAllowedDownloadUrl("https://raw.githubusercontent.com/file")).toBe(true);
      expect(isAllowedDownloadUrl("http://github.com/insecure")).toBe(false);
      expect(isAllowedDownloadUrl("https://evil.com/fake.tar.gz")).toBe(false);
      expect(isAllowedDownloadUrl("not-a-url")).toBe(false);
    });

    it("computeFileSha256 produces valid hex digest (Issue #19)", () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-hash-test-"));
      try {
        const filePath = path.join(tempTarget, "test.txt");
        fs.writeFileSync(filePath, "nanos-lint-test");
        const hash = computeFileSha256(filePath);
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("downloadAndExtractLuaLS rejects untrusted redirect URLs (Issue #19)", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-redirect-test-"));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: "https://evil-mirror.com/asset.tar.gz",
        body: { cancel: vi.fn() },
      } as unknown as Response);
      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false })
        ).rejects.toThrow(/Redirect to untrusted URL blocked/);
      } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("downloadAndExtractLuaLS refuses to chmod or execute archive-planted symlink (Issue #20)", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-symlink-extract-"));
      const origLstat = fs.lstatSync;
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation((filePath, options) => {
        const str = String(filePath);
        if (str.includes("lua-language-server")) {
          return {
            isSymbolicLink: () => true,
            isFile: () => false,
            size: 200_000,
          } as unknown as fs.Stats;
        }
        return origLstat(filePath, options);
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: Readable.from([Buffer.from("archive-content")]),
      } as unknown as Response);

      const origExists = fs.existsSync;
      const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (String(p).includes("lua-language-server")) return true;
        return origExists(p);
      });

      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false })
        ).rejects.toThrow(/symbolic link/);
      } finally {
        lstatSpy.mockRestore();
        existsSpy.mockRestore();
        globalThis.fetch = originalFetch;
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });
  });

  describe("getLegacyCacheDir", () => {
    it("falls back to the home directory cache when no platform base is set", () => {
      const origLocal = process.env.LOCALAPPDATA;
      const origXdg = process.env.XDG_CACHE_HOME;
      try {
        delete process.env.LOCALAPPDATA;
        delete process.env.XDG_CACHE_HOME;

        const expectedBase =
          process.platform === "win32"
            ? path.join(os.homedir(), "AppData", "Local")
            : path.join(os.homedir(), ".cache");
        expect(getLegacyCacheDir("3.19.1")).toBe(
          path.join(expectedBase, "nanos-lint", "luals", "3.19.1")
        );
      } finally {
        if (origLocal !== undefined) process.env.LOCALAPPDATA = origLocal;
        else delete process.env.LOCALAPPDATA;
        if (origXdg !== undefined) process.env.XDG_CACHE_HOME = origXdg;
        else delete process.env.XDG_CACHE_HOME;
      }
    });

    it("resolves the legacy layout from the platform cache base", () => {
      const origLocal = process.env.LOCALAPPDATA;
      const origXdg = process.env.XDG_CACHE_HOME;
      const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-legacy-env-"));
      try {
        if (process.platform === "win32") {
          process.env.LOCALAPPDATA = tempBase;
          expect(getLegacyCacheDir("3.19.1")).toBe(
            path.join(tempBase, "nanos-lint", "luals", "3.19.1")
          );
        } else {
          process.env.XDG_CACHE_HOME = tempBase;
          expect(getLegacyCacheDir("3.19.1")).toBe(
            path.join(tempBase, "nanos-lint", "luals", "3.19.1")
          );
        }
      } finally {
        if (origLocal !== undefined) process.env.LOCALAPPDATA = origLocal;
        else delete process.env.LOCALAPPDATA;
        if (origXdg !== undefined) process.env.XDG_CACHE_HOME = origXdg;
        else delete process.env.XDG_CACHE_HOME;
        fs.rmSync(tempBase, { recursive: true, force: true });
      }
    });
  });
});


