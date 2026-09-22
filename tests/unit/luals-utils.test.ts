import { describe, it, expect, vi } from "vitest";
import {
  escapePowerShellSingleQuote,
  resolveLatestLuaLSVersion,
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

