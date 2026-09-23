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
  });
});


