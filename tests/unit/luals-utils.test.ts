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
  isBinaryRunnable,
  runLuaLSCheck,
  downloadAndExtractLuaLS,
  limitDownloadStream,
  isAllowedDownloadUrl,
  computeFileSha256,
  MAX_DECOMPRESSED_SIZE_BYTES,
  MAX_ARCHIVE_MEMBER_COUNT,
  parseTarTvSize,
  validateArchiveMembers,
} from "../../src/luals.js";
import { logger } from "../../src/logger.js";
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
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

interface TarTestEntry {
  name: string;
  size?: number;
  type?: string;
  linkname?: string;
  content?: Buffer;
}

const liveTestsEnabled = isLiveTestsEnabled();

describe("luals utilities", () => {
  it("escapes single quotes correctly for PowerShell single-quoted commands", () => {
    const cases: [string, string][] = [
      ["C:\\Users\\John O'Connor\\AppData", "C:\\Users\\John O''Connor\\AppData"],
      ["normal_path/without/quotes", "normal_path/without/quotes"],
      ["a'b'c'd", "a''b''c''d"],
    ];
    for (const [input, expected] of cases)
      expect(escapePowerShellSingleQuote(input)).toBe(expected);
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
      const cases: [string, string][] = [
        ["3.19.1", "3.19.1"],
        ["v3.19.1", "3.19.1"],
        ["  3.19.1  ", "3.19.1"],
        ["3.19.1-nightly.2", "3.19.1-nightly.2"],
        ["V3", "V3"],
        ["alpha.1", "alpha.1"],
      ];
      for (const [inVal, outVal] of cases) expect(sanitizeLuaLSVersion(inVal)).toBe(outVal);
    });

    it("rejects values that could escape the cache directory", () => {
      // prettier-ignore
      const rejected = [
        "../../etc", "..", ".", "3.19.1/../../evil", "C:\\Windows\\System32\\evil",
        "3.19.1; rm -rf /", "3.19.1$(whoami)", "", "   ", "v", "-3.19.1", "a".repeat(65),
      ];
      for (const val of rejected) expect(sanitizeLuaLSVersion(val)).toBeNull();
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
        /Invalid LuaLS version/,
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
    it.skipIf(!liveTestsEnabled)(
      "returns a valid process.env.LUALS_BIN override without resolving a version",
      async () => {
        const origBin = process.env.LUALS_BIN;
        const realBinary = await getSharedLuaLSBinary();
        try {
          process.env.LUALS_BIN = realBinary;

          await expect(resolveLuaLSBinary("3.13.6")).resolves.toBe(realBinary);
        } finally {
          if (origBin !== undefined) {
            process.env.LUALS_BIN = origBin;
          } else {
            delete process.env.LUALS_BIN;
          }
        }
      },
    );

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
      globalThis.fetch = vi
        .fn()
        .mockImplementation((_url: string | URL | Request, init?: RequestInit) => {
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

    it.skipIf(!liveTestsEnabled)(
      "returns the primary cache directory when a valid binary and marker exist",
      async () => {
        const baseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-find-primary-"));
        try {
          const seeded = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
          const expectedDir = path.resolve(seeded, "..", "..");
          expect(findExistingLuaLSDir(FALLBACK_LUALS_VERSION, baseCacheDir)).toBe(expectedDir);
        } finally {
          fs.rmSync(baseCacheDir, { recursive: true, force: true });
        }
      },
    );
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

    it("returns false instead of throwing when the path cannot be inspected", () => {
      const tempBin = path.join(os.tmpdir(), `test-stat-fail-${Date.now()}.bin`);
      fs.writeFileSync(tempBin, Buffer.alloc(100_005));
      const statSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw new Error("EIO: i/o error");
      });
      try {
        expect(isBinaryValid(tempBin)).toBe(false);
      } finally {
        statSpy.mockRestore();
        fs.unlinkSync(tempBin);
      }
    });
  });

  describe("isBinaryRunnable", () => {
    it("returns false for a non-existent path or a directory", () => {
      expect(isBinaryRunnable("/path/to/nonexistent/bin")).toBe(false);
      expect(isBinaryRunnable(os.tmpdir())).toBe(false);
    });

    it("returns false for a file that does not run or reports no version", () => {
      const tempFile = path.join(os.tmpdir(), `test-runnable-${Date.now()}.bin`);
      // Deliberately below the downloaded-archive size floor: the size heuristic
      // must not decide the outcome here.
      fs.writeFileSync(tempFile, "not a lua-language-server");
      try {
        expect(isBinaryRunnable(tempFile)).toBe(false);
      } finally {
        fs.unlinkSync(tempFile);
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
            exclude: [
              "ignored/**",
              "vendor/*.lua",
              "temp-?.lua",
              "*.bak",
              "**/nested/*.lua",
              "build/**",
            ],
          },
        }),
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

    it("does not loop infinitely or inflate count on circular symlinks (Issue #21)", () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-symlink-loop-"));
      try {
        const packDir = path.join(tempRoot, "pack");
        fs.mkdirSync(packDir, { recursive: true });
        fs.writeFileSync(path.join(packDir, "a.lua"), "print('hi')");

        try {
          const linkPath = path.join(packDir, "self");
          fs.symlinkSync(packDir, linkPath, process.platform === "win32" ? "junction" : "dir");
        } catch (err) {
          void err;
        }

        const count = countCheckedFiles(tempRoot);
        expect(count).toBe(1);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe("resolveLuaLSBinary", () => {
    it("rejects a LUALS_BIN environment variable pointing to a non-runnable file (Issue #26)", async () => {
      const origBin = process.env.LUALS_BIN;
      const tempBin = path.join(os.tmpdir(), `fake-luals-${Date.now()}.exe`);
      fs.writeFileSync(tempBin, "binary");
      process.env.LUALS_BIN = tempBin;
      try {
        await expect(resolveLuaLSBinary()).rejects.toThrow(
          /LUALS_BIN.*not a runnable LuaLS binary/,
        );
      } finally {
        if (origBin !== undefined) {
          process.env.LUALS_BIN = origBin;
        } else {
          delete process.env.LUALS_BIN;
        }
        fs.unlinkSync(tempBin);
      }
    });

    it("rejects a LUALS_BIN pointing at an unrelated executable (Issue #26)", async () => {
      const origBin = process.env.LUALS_BIN;
      process.env.LUALS_BIN = process.execPath;
      try {
        // The Node.js binary runs fine but reports "v24.x.y", not a LuaLS release.
        await expect(resolveLuaLSBinary()).rejects.toThrow(
          /LUALS_BIN.*not a runnable LuaLS binary/,
        );
      } finally {
        if (origBin !== undefined) {
          process.env.LUALS_BIN = origBin;
        } else {
          delete process.env.LUALS_BIN;
        }
      }
    });

    it.skipIf(process.platform === "win32")(
      "accepts a thin wrapper script for LUALS_BIN when it reports a version (Issue #26)",
      async () => {
        const origBin = process.env.LUALS_BIN;
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-wrapper-"));
        const wrapper = path.join(tempDir, "lua-language-server");
        try {
          // Deliberately far below the 100 KB floor applied to downloaded
          // archives: Homebrew/mason-style installations are wrapper scripts.
          fs.writeFileSync(wrapper, "#!/bin/sh\necho 3.19.1\n", { mode: 0o755 });

          expect(isBinaryRunnable(wrapper)).toBe(true);
          expect(isBinaryValid(wrapper)).toBe(false);

          process.env.LUALS_BIN = wrapper;
          await expect(resolveLuaLSBinary()).resolves.toBe(wrapper);
        } finally {
          if (origBin !== undefined) {
            process.env.LUALS_BIN = origBin;
          } else {
            delete process.env.LUALS_BIN;
          }
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
    );
  });

  describe("runLuaLSCheck", () => {
    it("throws if targetPath does not exist", async () => {
      await expect(
        runLuaLSCheck("/nonexistent/target/path", "dummy-config.json", {
          path: "/nonexistent/target/path",
          checklevel: "Warning",
          lualsVersion: "3.19.1",
        }),
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
      },
    );

    it.skipIf(!isLiveTestsEnabled())(
      "runs check on a failing file without checklevel and counts warnings and problem files",
      async () => {
        const failFile = path.resolve("tests/fail/type_mismatch.lua");
        expect(fs.existsSync(failFile), "tests/fail/type_mismatch.lua fixture must exist").toBe(
          true,
        );

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
              path.resolve(failFile).toLowerCase(),
            );
          }
        } finally {
          if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
            fs.unlinkSync(resolved.configPath);
          }
        }
      },
    );

    it.skipIf(!liveTestsEnabled)(
      "filters diagnostics down to the requested target paths when several are passed",
      async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-multi-path-"));
        const requestedDir = path.join(tempDir, "Requested");
        const otherDir = path.join(tempDir, "Other");
        fs.mkdirSync(requestedDir);
        fs.mkdirSync(otherDir);
        fs.writeFileSync(
          path.join(requestedDir, "kept.lua"),
          "CallUndefinedInRequested()\n",
          "utf-8",
        );
        fs.writeFileSync(path.join(otherDir, "skipped.lua"), "CallUndefinedInOther()\n", "utf-8");

        const resolved = resolveWorkspaceConfig(tempDir, undefined, {
          annotationsPath: await getSharedAnnotations(),
        });
        try {
          const result = await runLuaLSCheck(tempDir, resolved.configPath, {
            path: tempDir,
            paths: [requestedDir],
            checklevel: "Warning",
            lualsBin: await getSharedLuaLSBinary(),
          });

          expect(result.passed).toBe(false);
          const reported = Object.keys(result.diagnostics).map((uri) =>
            path.relative(tempDir, path.resolve(fileUriToPath(uri))).replace(/\\/g, "/"),
          );
          expect(reported).toContain("Requested/kept.lua");
          expect(reported).not.toContain("Other/skipped.lua");
        } finally {
          if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
            fs.unlinkSync(resolved.configPath);
          }
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(!liveTestsEnabled)(
      "resolves an explicitly requested version from an injected cache without downloading",
      async () => {
        const baseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-explicit-cache-"));
        try {
          const seeded = await seedCachedLuaLS(baseCacheDir, "3.19.1");
          const binary = await resolveLuaLSBinary("3.19.1", {
            cacheDir: baseCacheDir,
          });
          expect(binary).toBe(seeded);
          expect(fs.existsSync(binary)).toBe(true);
        } finally {
          fs.rmSync(baseCacheDir, { recursive: true, force: true });
        }
      },
    );

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
      "reuses an existing installation, returns immediately when complete",
      async () => {
        const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-download-reuse-"));
        try {
          const bin = await downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, tempTarget, {});
          expect(fs.existsSync(bin)).toBe(true);
          expect(fs.existsSync(path.join(tempTarget, ".complete"))).toBe(true);

          // Second invocation on an already complete directory returns immediately
          const bin2 = await downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, tempTarget, {});
          expect(bin2).toBe(bin);
        } finally {
          fs.rmSync(tempTarget, { recursive: true, force: true });
        }
      },
    );

    it("handles download failure when fetch rejects", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-dl-fail-"));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network connection error"));
      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
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
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
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
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
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
          body: { cancel: vi.fn().mockRejectedValue(new Error("non-ok cancel error")) },
        } as unknown as Response);
      });
      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
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
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
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
      expect(isAllowedDownloadUrl("https://release-assets.githubusercontent.com/asset.zip")).toBe(
        true,
      );
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

    it("computeFileSha256 hashes empty and multi-chunk files in bounded memory (Issue #18/#19)", () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-hash-chunks-"));
      try {
        const emptyFile = path.join(tempTarget, "empty.bin");
        fs.writeFileSync(emptyFile, "");
        expect(computeFileSha256(emptyFile)).toBe(crypto.createHash("sha256").digest("hex"));

        // ~3 MiB of non-repeating bytes plus a partial final chunk, so a read
        // that re-hashes the same buffer or drops a chunk changes the digest.
        const payload = Buffer.alloc(3 * 1024 * 1024 + 12_345);
        for (let i = 0; i < payload.length; i++) {
          payload[i] = (i * 31 + 7) % 256;
        }
        const chunkedFile = path.join(tempTarget, "chunked.bin");
        fs.writeFileSync(chunkedFile, payload);

        expect(computeFileSha256(chunkedFile)).toBe(
          crypto.createHash("sha256").update(payload).digest("hex"),
        );
      } finally {
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("downloadAndExtractLuaLS rejects untrusted redirect URLs without retrying (Issue #19)", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-redirect-test-"));
      const originalFetch = globalThis.fetch;
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const cancelFn = vi.fn();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: "https://evil-mirror.com/asset.tar.gz",
        body: { cancel: cancelFn },
      } as unknown as Response);
      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
        ).rejects.toMatchObject({
          name: "LuaLSError",
          code: "ERR_LUALS_DOWNLOAD",
          remedy: "Download redirects must stay on allowlisted HTTPS GitHub hosts.",
          message: expect.stringContaining(
            "Redirect to untrusted URL blocked: https://evil-mirror.com/asset.tar.gz",
          ),
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(cancelFn).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            "Redirect to untrusted URL blocked: https://evil-mirror.com/asset.tar.gz",
          ),
        );
      } finally {
        warnSpy.mockRestore();
        globalThis.fetch = originalFetch;
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("surfaces untrusted redirect error when body has no cancel or cancel rejects", async () => {
      const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-redirect-nocancel-"));
      const originalFetch = globalThis.fetch;
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          url: "https://evil-mirror.com/asset.tar.gz",
          body: Readable.from(["payload"]),
        } as unknown as Response);
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
        ).rejects.toMatchObject({ code: "ERR_LUALS_DOWNLOAD" });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);

        const rejectingCancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          url: "https://evil-mirror.com/asset.tar.gz",
          body: { cancel: rejectingCancel },
        } as unknown as Response);
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
        ).rejects.toMatchObject({ code: "ERR_LUALS_DOWNLOAD" });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(rejectingCancel).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
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
      // A real (empty) gzip-compressed tar archive: extraction must succeed so
      // the test reaches the archive-planted symlink guard it asserts on.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: Readable.from([gzipSync(Buffer.alloc(1024))]),
      } as unknown as Response);

      const origExists = fs.existsSync;
      const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (String(p).includes("lua-language-server")) return true;
        return origExists(p);
      });

      try {
        await expect(
          downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
        ).rejects.toThrow(/symbolic link/);
      } finally {
        lstatSpy.mockRestore();
        existsSpy.mockRestore();
        globalThis.fetch = originalFetch;
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    });

    it("parseTarTvSize parses verbose tar outputs correctly (Issue #31)", () => {
      const cases: [string, number][] = [
        ["-rwxr-xr-x 1000/1000 18239240 2024-05-01 12:00 bin/luals", 18239240],
        ["-rwxr-xr-x  0 0      0 18239240 May  1  2024 bin/luals", 18239240],
        ["-rw-r--r-- 0/0 100 2024-01-01 00:00 file.txt", 100],
        ["drwxr-xr-x 0 0 0 0 May 1 2024 dir/", 0],
        ["invalid line", 0],
      ];
      for (const [line, expected] of cases) expect(parseTarTvSize(line)).toBe(expected);
    });

    it("validateArchiveMembers and downloadAndExtractLuaLS enforce size and member bounds (Issue #31)", async () => {
      expect(MAX_DECOMPRESSED_SIZE_BYTES).toBe(500 * 1024 * 1024);
      expect(MAX_ARCHIVE_MEMBER_COUNT).toBe(10_000);

      const helperCreateTarGz = (entries: TarTestEntry[]): Buffer => {
        const chunks: Buffer[] = [];
        for (const entry of entries) {
          const header = Buffer.alloc(512);
          const content = entry.content ?? Buffer.alloc(0);
          const size = entry.size !== undefined ? entry.size : content.length;
          header.write(entry.name, 0, 100, "utf-8");
          header.write("0000644\x00", 100, 8, "utf-8");
          header.write("0000000\x000000000\x00", 108, 16, "utf-8");
          header.write(
            size.toString(8).padStart(11, "0") + "\x0014000000000\x00        ",
            124,
            32,
            "utf-8",
          );
          header.write(entry.type ?? "0", 156, 1, "utf-8");
          if (entry.linkname) header.write(entry.linkname, 157, 100, "utf-8");
          header.write("ustar\x0000", 257, 8, "utf-8");
          let chksum = 0;
          for (let i = 0; i < 512; i++) chksum += header[i]!;
          header.write(chksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");
          chunks.push(header);
          if (content.length > 0) {
            chunks.push(content);
            const pad = (512 - (content.length % 512)) % 512;
            if (pad > 0) chunks.push(Buffer.alloc(pad));
          }
        }
        chunks.push(Buffer.alloc(1024));
        return gzipSync(Buffer.concat(chunks));
      };

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-archive-test-"));
      try {
        // 1. Directory escape in archive
        const escapeArchive = path.join(tempDir, "escape.tar.gz");
        fs.writeFileSync(escapeArchive, helperCreateTarGz([{ name: "../evil.sh" }]));
        await expect(validateArchiveMembers(escapeArchive)).rejects.toThrow(
          /Archive member path escapes extraction directory/,
        );

        // 2. Symlink in archive
        const symlinkArchive = path.join(tempDir, "symlink.tar.gz");
        fs.writeFileSync(
          symlinkArchive,
          helperCreateTarGz([
            { name: "tool", content: Buffer.from("abc") },
            { name: "link-tool", type: "2", linkname: "tool" },
          ]),
        );
        await expect(validateArchiveMembers(symlinkArchive)).rejects.toThrow(
          /symbolic or hard link/,
        );

        // 3. Decompressed size exceeds limit in listing (using minimal zip with declared uncompressed size)
        const makeOversizedZip = () => {
          const lh = Buffer.alloc(38);
          lh.writeUInt32LE(0x04034b50, 0);
          lh.writeUInt16LE(20, 4);
          lh.writeUInt32LE(600 * 1024 * 1024, 22);
          lh.writeUInt16LE(8, 26);
          lh.write("huge.bin", 30, "utf-8");
          const ch = Buffer.alloc(54);
          ch.writeUInt32LE(0x02014b50, 0);
          ch.writeUInt16LE(20, 4);
          ch.writeUInt16LE(20, 6);
          ch.writeUInt32LE(600 * 1024 * 1024, 24);
          ch.writeUInt16LE(8, 28);
          ch.writeUInt32LE(0, 42);
          ch.write("huge.bin", 46, "utf-8");
          const eo = Buffer.alloc(22);
          eo.writeUInt32LE(0x06054b50, 0);
          eo.writeUInt16LE(1, 8);
          eo.writeUInt16LE(1, 10);
          eo.writeUInt32LE(ch.length, 12);
          eo.writeUInt32LE(lh.length, 16);
          return Buffer.concat([lh, ch, eo]);
        };
        const oversizedZip = path.join(tempDir, "oversized.zip");
        fs.writeFileSync(oversizedZip, makeOversizedZip());
        await expect(validateArchiveMembers(oversizedZip)).rejects.toThrow(
          /declared decompressed size.*exceeds maximum limit/,
        );

        // 4. Member count exceeds limit
        const countEntries = Array.from({ length: 10_005 }, (_, i) => ({
          name: `f${i}.txt`,
        }));
        const countArchive = path.join(tempDir, "count.tar.gz");
        fs.writeFileSync(countArchive, helperCreateTarGz(countEntries));
        await expect(validateArchiveMembers(countArchive)).rejects.toThrow(
          /member count.*exceeds maximum limit/,
        );

        // 4. Post-extraction size check
        const targetDir = path.join(tempDir, "post-extract-dest");
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers(),
          body: Readable.from([gzipSync(Buffer.alloc(1024))]),
        } as unknown as Response);

        const pathsModule = await import("../../src/paths.js");
        const dirSizeSpy = vi
          .spyOn(pathsModule, "getDirectorySize")
          .mockReturnValue(600 * 1024 * 1024);
        try {
          await expect(
            downloadAndExtractLuaLS("3.19.1", targetDir, { reuseExisting: false }),
          ).rejects.toThrow(/Extracted archive size.*exceeds maximum limit/);
        } finally {
          dirSizeSpy.mockRestore();
          globalThis.fetch = originalFetch;
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it.skipIf(!liveTestsEnabled)(
      "extracts into a destination reached through a symlinked directory",
      async () => {
        // `os.tmpdir()` is reached through a symlink on macOS (`/var` ->
        // `/private/var`), so the extraction directory must be canonicalized on
        // both sides of the escape check or every download is rejected.
        const realBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-linked-dest-"));
        const linkBase = `${realBase}-link`;
        const seedBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-linked-seed-"));
        try {
          try {
            fs.symlinkSync(realBase, linkBase, process.platform === "win32" ? "junction" : "dir");
          } catch (err) {
            // Creating links can require elevated privileges on some Windows setups.
            void err;
          }

          await seedCachedLuaLS(seedBase, FALLBACK_LUALS_VERSION);
          const targetDir = path.join(linkBase, FALLBACK_LUALS_VERSION);

          const bin = await downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, targetDir, {
            cacheDir: seedBase,
          });

          expect(bin.startsWith(linkBase)).toBe(true);
          expect(fs.existsSync(bin)).toBe(true);
        } finally {
          try {
            fs.unlinkSync(linkBase);
          } catch (err) {
            void err;
          }
          fs.rmSync(realBase, { recursive: true, force: true });
          fs.rmSync(seedBase, { recursive: true, force: true });
        }
      },
    );
  });
});
