import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isAnnotationsValid,
  MIN_ANNOTATIONS_SIZE_BYTES,
  readAnnotationsMetadata,
  resolveAnnotations,
} from "../../src/annotations.js";
import {
  readLuaLSMetadata,
  findExistingLuaLSDir,
  resolveLuaLSBinary,
  getPlatformInfo,
  getIsoWeek,
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

    it("returns false for file smaller than MIN_ANNOTATIONS_SIZE_BYTES", () => {
      expect(MIN_ANNOTATIONS_SIZE_BYTES).toBe(1000);
      const smallFile = path.join(tempDir, "small.lua");
      fs.writeFileSync(smallFile, "-- short lua file");
      expect(isAnnotationsValid(smallFile)).toBe(false);
    });

    it("returns false for file without valid header comments", () => {
      const invalidHeader = path.join(tempDir, "invalid-header.lua");
      fs.writeFileSync(invalidHeader, "1234567890".repeat(200));
      expect(isAnnotationsValid(invalidHeader)).toBe(false);
    });

    it("returns false for file with generic comment not containing @meta or nanos world (Issue #24)", () => {
      const genericFile = path.join(tempDir, "generic.lua");
      fs.writeFileSync(genericFile, "-- generic comment\n" + " ".repeat(1500));
      expect(isAnnotationsValid(genericFile)).toBe(false);
    });

    it("returns true for valid annotations file starting with ---@meta (Issue #24)", () => {
      const metaFile = path.join(tempDir, "meta.lua");
      fs.writeFileSync(metaFile, "---@meta\n" + " ".repeat(1500));
      expect(isAnnotationsValid(metaFile)).toBe(true);
    });

    it("returns true for valid annotations file containing nanos world", () => {
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

    it("purges LuaLS metadata.json when latestVersion contains path traversal (Issue #17)", () => {
      const metaPath = path.join(tempDir, "metadata.json");
      fs.writeFileSync(
        metaPath,
        JSON.stringify({ lastCheckedWeek: getIsoWeek(), latestVersion: "../EVIL" })
      );

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
          text: () => Promise.resolve("---@meta\n-- nanos world annotations\n" + " ".repeat(1500)),
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
      const version = "9.9.2";
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

      const origLocal = process.env.LOCALAPPDATA;
      const origXdg = process.env.XDG_CACHE_HOME;
      const isolatedLegacy = path.join(tempDir, "isolated-legacy");
      if (process.platform === "win32") {
        process.env.LOCALAPPDATA = isolatedLegacy;
      } else {
        process.env.XDG_CACHE_HOME = isolatedLegacy;
      }

      try {
        await expect(
          resolveLuaLSBinary(version, { cacheDir: tempDir, reuseExisting: false })
        ).rejects.toThrow(/is corrupted \(failed execution\/size check\) and cannot be re-downloaded while offline/);
      } finally {
        globalThis.fetch = originalFetch;
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
      }
    });

    it("ignores legacy cache directory when its binary is corrupted or truncated", () => {
      const version = "9.9.3";
      const info = getPlatformInfo(version);
      const legacyBase = path.join(tempDir, "legacy-base");
      const legacyDir = path.join(legacyBase, "nanos-lint", "luals", version);
      const legacyBin = path.join(legacyDir, info.binaryRelativePath);
      fs.mkdirSync(path.dirname(legacyBin), { recursive: true });
      fs.writeFileSync(legacyBin, "corrupted");
      fs.writeFileSync(path.join(legacyDir, ".complete"), version);

      const origLocal = process.env.LOCALAPPDATA;
      const origXdg = process.env.XDG_CACHE_HOME;
      if (process.platform === "win32") {
        process.env.LOCALAPPDATA = legacyBase;
      } else {
        process.env.XDG_CACHE_HOME = legacyBase;
      }

      try {
        // findExistingLuaLSDir should return null because legacy binary is corrupt
        const result = findExistingLuaLSDir(version, tempDir);
        expect(result).toBeNull();
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
      }
    });

    it("rejects traversal latestVersion in metadata.json and does not escape cache (Issue #17)", async () => {
      const lualsDir = path.join(tempDir, "luals");
      fs.mkdirSync(lualsDir, { recursive: true });
      fs.writeFileSync(
        path.join(lualsDir, "metadata.json"),
        JSON.stringify({ lastCheckedWeek: getIsoWeek(), latestVersion: "../EVIL" }),
        "utf8"
      );

      // Plant a plausible binary where the un-sanitized join pointed: <tempDir>/EVIL/bin/lua-language-server
      const evilBin = path.join(
        tempDir,
        "EVIL",
        process.platform === "win32" ? "bin/lua-language-server.exe" : "bin/lua-language-server"
      );
      fs.mkdirSync(path.dirname(evilBin), { recursive: true });
      fs.writeFileSync(evilBin, "#!/bin/sh\necho 1.2.3\n" + "#".repeat(120000), { mode: 0o755 });

      // Mock fetch so it doesn't do real network calls
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("network disabled"));

      // Point the legacy cache location at an empty directory: otherwise a valid
      // LuaLS installation (such as the shared live-test fixture) can legitimately
      // satisfy the request and the traversal path is never exercised.
      const emptyCacheBase = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-empty-legacy-"));
      const origLocal = process.env.LOCALAPPDATA;
      const origXdg = process.env.XDG_CACHE_HOME;
      const origHome = process.env.HOME;
      if (process.platform === "win32") {
        process.env.LOCALAPPDATA = emptyCacheBase;
      } else if (process.platform === "darwin") {
        process.env.HOME = emptyCacheBase;
      } else {
        process.env.XDG_CACHE_HOME = emptyCacheBase;
      }

      try {
        await expect(
          resolveLuaLSBinary("latest", { cacheDir: lualsDir, quiet: true, reuseExisting: true })
        ).rejects.toThrow();
        // The traversing version was dropped and replaced by the safe fallback.
        expect(readLuaLSMetadata(lualsDir)?.latestVersion).toBe(FALLBACK_LUALS_VERSION);
      } finally {
        globalThis.fetch = origFetch;
        if (origLocal !== undefined) process.env.LOCALAPPDATA = origLocal;
        else delete process.env.LOCALAPPDATA;
        if (origXdg !== undefined) process.env.XDG_CACHE_HOME = origXdg;
        else delete process.env.XDG_CACHE_HOME;
        if (origHome !== undefined) process.env.HOME = origHome;
        else delete process.env.HOME;
        fs.rmSync(emptyCacheBase, { recursive: true, force: true });
      }
    });
  });
});
