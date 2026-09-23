import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isAnnotationsValid,
  readAnnotationsMetadata,
  resolveAnnotations,
} from "../../src/annotations.js";
import {
  readLuaLSMetadata,
  findExistingLuaLSDir,
  resolveLuaLSBinary,
  getPlatformInfo,
  FALLBACK_LUALS_VERSION,
} from "../../src/luals/index.js";

describe("Cache Corruption Detection and Self-Healing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-corruption-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  describe("isAnnotationsValid validator", () => {
    it("returns false for nonexistent file", () => {
      expect(isAnnotationsValid(path.join(tempDir, "missing.lua"))).toBe(false);
    });

    it("returns false for directory", () => {
      const dir = path.join(tempDir, "some-dir");
      fs.mkdirSync(dir);
      expect(isAnnotationsValid(dir)).toBe(false);
    });

    it("returns false for 0-byte file", () => {
      const emptyFile = path.join(tempDir, "empty.lua");
      fs.writeFileSync(emptyFile, "");
      expect(isAnnotationsValid(emptyFile)).toBe(false);
    });

    it("returns false for file smaller than 1000 bytes", () => {
      const smallFile = path.join(tempDir, "small.lua");
      fs.writeFileSync(smallFile, "-- short lua file");
      expect(isAnnotationsValid(smallFile)).toBe(false);
    });

    it("returns false for file without valid header comments", () => {
      const invalidHeader = path.join(tempDir, "invalid-header.lua");
      fs.writeFileSync(invalidHeader, "1234567890".repeat(200));
      expect(isAnnotationsValid(invalidHeader)).toBe(false);
    });

    it("returns true for valid annotations file (>=1000 bytes with comment)", () => {
      const validFile = path.join(tempDir, "valid.lua");
      fs.writeFileSync(validFile, "-- nanos world annotations\n" + " ".repeat(1500));
      expect(isAnnotationsValid(validFile)).toBe(true);
    });
  });

  describe("Metadata self-healing on corrupted JSON", () => {
    it("purges corrupted annotations metadata.json on parse failure", () => {
      const metaPath = path.join(tempDir, "metadata.json");
      fs.writeFileSync(metaPath, "NOT_JSON{{{");

      const result = readAnnotationsMetadata(tempDir);
      expect(result).toBeNull();
      expect(fs.existsSync(metaPath)).toBe(false);
    });

    it("purges annotations metadata.json missing required fields", () => {
      const metaPath = path.join(tempDir, "metadata.json");
      fs.writeFileSync(metaPath, JSON.stringify({ wrongField: 123 }));

      const result = readAnnotationsMetadata(tempDir);
      expect(result).toBeNull();
      expect(fs.existsSync(metaPath)).toBe(false);
    });

    it("purges corrupted LuaLS metadata.json on parse failure", () => {
      const metaPath = path.join(tempDir, "metadata.json");
      fs.writeFileSync(metaPath, "{malformed: json");

      const result = readLuaLSMetadata(tempDir);
      expect(result).toBeNull();
      expect(fs.existsSync(metaPath)).toBe(false);
    });

    it("purges LuaLS metadata.json missing required fields", () => {
      const metaPath = path.join(tempDir, "metadata.json");
      fs.writeFileSync(metaPath, JSON.stringify({ someKey: "value" }));

      const result = readLuaLSMetadata(tempDir);
      expect(result).toBeNull();
      expect(fs.existsSync(metaPath)).toBe(false);
    });
  });

  describe("Annotations recovery from corrupted cached files", () => {
    it("purges 0-byte cached annotations and downloads fresh copy", async () => {
      const cachedFile = path.join(tempDir, "annotations.lua");
      fs.writeFileSync(cachedFile, "");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("commits")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ sha: "recovered123" }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("-- nanos world recovered\n" + " ".repeat(1500)),
        } as unknown as Response);
      });

      try {
        const resolved = await resolveAnnotations({ cacheDir: tempDir });
        expect(resolved).toBe(cachedFile);
        expect(isAnnotationsValid(cachedFile)).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("purges corrupted cached annotations and reports error when offline", async () => {
      const cachedFile = path.join(tempDir, "annotations.lua");
      fs.writeFileSync(cachedFile, "CORRUPTED TRUNCATED");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network offline"));

      try {
        await expect(resolveAnnotations({ cacheDir: tempDir })).rejects.toThrow(
          /Failed to resolve nanos world API annotations\. Please check your network connection/
        );
        expect(fs.existsSync(cachedFile)).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("ignores corrupted bundled annotations in package root and resolves via cache", async () => {
      const fakeRoot = path.join(tempDir, "fake-root");
      fs.mkdirSync(fakeRoot, { recursive: true });
      const corruptBundled = path.join(fakeRoot, "annotations.lua");
      fs.writeFileSync(corruptBundled, "CORRUPT");

      const configModule = await import("../../src/config.js");
      const rootSpy = vi.spyOn(configModule, "getPackageRoot").mockReturnValue(fakeRoot);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("commits")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ sha: "valid123" }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("-- valid annotations\n" + " ".repeat(1500)),
        } as unknown as Response);
      });

      try {
        const resolved = await resolveAnnotations({ cacheDir: tempDir });
        expect(resolved).not.toBe(corruptBundled);
        expect(resolved).toBe(path.join(tempDir, "annotations.lua"));
      } finally {
        rootSpy.mockRestore();
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("LuaLS binary corruption and legacy cache handling", () => {
    it("throws actionable offline error when cached binary is corrupted and offline", async () => {
      const version = "3.19.1";
      const info = getPlatformInfo(version);
      const versionDir = path.join(tempDir, version);
      const binDir = path.join(versionDir, path.dirname(info.binaryRelativePath));
      fs.mkdirSync(binDir, { recursive: true });

      const binPath = path.join(versionDir, info.binaryRelativePath);
      // Write corrupted 0-byte or invalid binary
      fs.writeFileSync(binPath, "not an executable");
      fs.writeFileSync(path.join(versionDir, ".complete"), version);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fetch failed offline"));

      try {
        await expect(
          resolveLuaLSBinary(version, { cacheDir: tempDir })
        ).rejects.toThrow(/is corrupted \(failed execution\/size check\) and cannot be re-downloaded while offline/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("ignores legacy cache directory when its binary is corrupted or truncated", () => {
      const version = FALLBACK_LUALS_VERSION;
      const info = getPlatformInfo(version);
      const legacyDir = path.join(tempDir, "nanos-lint", "luals", version);
      const legacyBin = path.join(legacyDir, info.binaryRelativePath);
      fs.mkdirSync(path.dirname(legacyBin), { recursive: true });
      fs.writeFileSync(legacyBin, "corrupted");

      // findExistingLuaLSDir should return null because legacy binary is corrupt
      const result = findExistingLuaLSDir(version, tempDir);
      expect(result).toBeNull();
    });
  });
});
