import { describe, it, expect, vi } from "vitest";
import {
  escapePowerShellSingleQuote,
  resolveLatestLuaLSVersion,
  resolveLuaLSVersion,
  sanitizeLuaLSVersion,
  FALLBACK_LUALS_VERSION,
  countCheckedFiles,
} from "../../src/luals.js";
import path from "node:path";

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
});

