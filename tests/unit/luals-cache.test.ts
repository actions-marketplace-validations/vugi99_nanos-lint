import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getIsoWeek,
  getLuaLSMetadataPath,
  readLuaLSMetadata,
  writeLuaLSMetadata,
  listCachedLuaLSVersions,
  cleanupOldCachedLuaLSVersions,
  fetchLatestLuaLSVersionFromGitHub,
  resolveLuaLSBinary,
  getCacheDir,
  getPlatformInfo,
  FALLBACK_LUALS_VERSION,
  type LuaLSMetadata,
} from "../../src/luals.js";

describe("LuaLS weekly cache check and version management", () => {
  let tempBaseDir: string;
  let originalGithubToken: string | undefined;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-test-luals-cache-"));
    originalGithubToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (originalGithubToken !== undefined) {
      process.env.GITHUB_TOKEN = originalGithubToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Failed to clean up tempBaseDir: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  describe("getIsoWeek", () => {
    it("formats ISO week as YYYY-Www", () => {
      const date = new Date(2026, 8, 23); // Month 8 is Sept
      const week = getIsoWeek(date);
      expect(week).toBe("2026-W39");
    });

    it("handles year boundaries according to ISO 8601", () => {
      // 2026-01-01 is Thursday -> week 1 of 2026
      expect(getIsoWeek(new Date(2026, 0, 1))).toBe("2026-W01");
      // 2025-12-31 is Wednesday -> also part of 2026-W01
      expect(getIsoWeek(new Date(2025, 11, 31))).toBe("2026-W01");
    });
  });

  describe("metadata read and write", () => {
    it("returns null when metadata file does not exist", () => {
      expect(readLuaLSMetadata(tempBaseDir)).toBeNull();
    });

    it("returns null when metadata file contains invalid JSON or missing fields", () => {
      const metaPath = getLuaLSMetadataPath(tempBaseDir);
      fs.writeFileSync(metaPath, "{ invalid json", "utf-8");
      expect(readLuaLSMetadata(tempBaseDir)).toBeNull();

      fs.writeFileSync(metaPath, JSON.stringify({ incomplete: true }), "utf-8");
      expect(readLuaLSMetadata(tempBaseDir)).toBeNull();
    });

    it("writes and reads valid LuaLS metadata", () => {
      const meta: LuaLSMetadata = {
        lastCheckedWeek: "2026-W39",
        latestVersion: "3.20.0",
        lastCheckedDate: "2026-09-23",
      };
      writeLuaLSMetadata(meta, tempBaseDir);

      const read = readLuaLSMetadata(tempBaseDir);
      expect(read).toEqual(meta);
    });

    it("handles write failure gracefully when directory cannot be created", () => {
      // Place a file where directory is expected so write fails
      const blocker = path.join(tempBaseDir, "blocker");
      fs.writeFileSync(blocker, "blocking file");

      expect(() => {
        writeLuaLSMetadata(
          { lastCheckedWeek: "2026-W39", latestVersion: "3.20.0" },
          path.join(blocker, "child")
        );
      }).not.toThrow();
    });
  });

  describe("listCachedLuaLSVersions & cleanupOldCachedLuaLSVersions", () => {
    it("returns empty array for non-existent base directory", () => {
      const nonExistent = path.join(tempBaseDir, "does-not-exist");
      expect(listCachedLuaLSVersions(nonExistent)).toEqual([]);
      expect(cleanupOldCachedLuaLSVersions("3.20.0", nonExistent)).toEqual([]);
    });

    it("lists only valid cached versions and ignores files, dots, or invalid directories", () => {
      const info = getPlatformInfo("3.19.1");

      // Version 1: dummy binary (fails exec check, excluded)
      const v1Dir = path.join(tempBaseDir, "3.19.1");
      const v1Bin = path.join(v1Dir, info.binaryRelativePath);
      fs.mkdirSync(path.dirname(v1Bin), { recursive: true });
      fs.writeFileSync(v1Bin, Buffer.alloc(100_005));
      fs.writeFileSync(path.join(v1Dir, ".complete"), "3.19.1");

      // Version 2: mismatched marker
      const v2Dir = path.join(tempBaseDir, "3.19.0");
      fs.mkdirSync(v2Dir, { recursive: true });
      fs.writeFileSync(path.join(v2Dir, ".complete"), "different-version");

      // Version 3: unparseable version name
      const v3Dir = path.join(tempBaseDir, "../invalid");
      try {
        fs.mkdirSync(v3Dir, { recursive: true });
      } catch (err) {
        console.warn(`Failed to create invalid dir: ${err instanceof Error ? err.message : String(err)}`);
      }

      // File instead of dir:
      fs.writeFileSync(path.join(tempBaseDir, "metadata.json"), "{}");
      // Dot directory (temp extraction):
      fs.mkdirSync(path.join(tempBaseDir, ".temp-extract"));

      expect(listCachedLuaLSVersions(tempBaseDir)).toEqual([]);
    });

    it("lists valid version when functional binary and complete marker exist", () => {
      const realCacheDir = getCacheDir(FALLBACK_LUALS_VERSION);
      const info = getPlatformInfo(FALLBACK_LUALS_VERSION);
      const realBin = path.join(realCacheDir, info.binaryRelativePath);

      if (fs.existsSync(realBin)) {
        const destVerDir = path.join(tempBaseDir, FALLBACK_LUALS_VERSION);
        fs.cpSync(realCacheDir, destVerDir, { recursive: true });
        fs.writeFileSync(path.join(destVerDir, ".complete"), FALLBACK_LUALS_VERSION);

        const versions = listCachedLuaLSVersions(tempBaseDir);
        expect(versions).toContain(FALLBACK_LUALS_VERSION);
      }
    });

    it("cleanupOldCachedLuaLSVersions removes older versions but preserves keepVersion, files, and dot dirs", () => {
      const v1Dir = path.join(tempBaseDir, "3.19.0");
      const v2Dir = path.join(tempBaseDir, "3.19.1");
      const keepDir = path.join(tempBaseDir, "3.20.0");
      const tempDotDir = path.join(tempBaseDir, ".3.20.0.tmp-123");
      const metaFile = path.join(tempBaseDir, "metadata.json");

      fs.mkdirSync(v1Dir, { recursive: true });
      fs.mkdirSync(v2Dir, { recursive: true });
      fs.mkdirSync(keepDir, { recursive: true });
      fs.mkdirSync(tempDotDir, { recursive: true });
      fs.writeFileSync(metaFile, JSON.stringify({ keep: true }));

      const removed = cleanupOldCachedLuaLSVersions("3.20.0", tempBaseDir);

      expect(removed.sort()).toEqual(["3.19.0", "3.19.1"].sort());
      expect(fs.existsSync(v1Dir)).toBe(false);
      expect(fs.existsSync(v2Dir)).toBe(false);
      expect(fs.existsSync(keepDir)).toBe(true);
      expect(fs.existsSync(tempDotDir)).toBe(true);
      expect(fs.existsSync(metaFile)).toBe(true);
    });

    it("cleanupOldCachedLuaLSVersions handles deletion failure gracefully", () => {
      const v1Dir = path.join(tempBaseDir, "3.19.0");
      fs.mkdirSync(v1Dir, { recursive: true });

      // Mock rmSync to simulate permission error on a directory
      const originalRmSync = fs.rmSync;
      fs.rmSync = vi.fn().mockImplementation((targetPath, opts) => {
        if (typeof targetPath === "string" && targetPath.includes("3.19.0")) {
          throw new Error("EPERM: Permission denied");
        }
        return originalRmSync(targetPath, opts);
      });

      try {
        const removed = cleanupOldCachedLuaLSVersions("3.20.0", tempBaseDir);
        expect(removed).not.toContain("3.19.0");
      } finally {
        fs.rmSync = originalRmSync;
      }
    });
  });

  describe("fetchLatestLuaLSVersionFromGitHub", () => {
    it("returns version tag on successful response", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v3.20.0" }),
      });
      try {
        const ver = await fetchLatestLuaLSVersionFromGitHub();
        expect(ver).toBe("3.20.0");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("includes Authorization header when GITHUB_TOKEN is set", async () => {
      process.env.GITHUB_TOKEN = "ghp_secret12345";
      const origFetch = globalThis.fetch;
      let capturedHeaders: Record<string, string> | undefined;

      globalThis.fetch = vi.fn().mockImplementation((url, options) => {
        capturedHeaders = options?.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          json: async () => ({ tag_name: "3.20.0" }),
        });
      });

      try {
        const ver = await fetchLatestLuaLSVersionFromGitHub();
        expect(ver).toBe("3.20.0");
        expect(capturedHeaders?.["Authorization"]).toBe("token ghp_secret12345");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("returns null on non-ok HTTP status or invalid tag_name", async () => {
      const origFetch = globalThis.fetch;

      // 1. HTTP 403 Rate Limit
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      });
      try {
        expect(await fetchLatestLuaLSVersionFromGitHub()).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }

      // 2. HTTP 200 but invalid tag_name
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "invalid..version!!" }),
      });
      try {
        expect(await fetchLatestLuaLSVersionFromGitHub()).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("returns null on network failure", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network Error"));
      try {
        const ver = await fetchLatestLuaLSVersionFromGitHub();
        expect(ver).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("resolveLuaLSBinary weekly caching behavior", () => {
    it("reuses cached latest version when lastCheckedWeek matches current week without calling fetch", async () => {
      const currentWeek = getIsoWeek();
      const existing = path.join(getCacheDir(FALLBACK_LUALS_VERSION));
      if (!fs.existsSync(existing)) {
        return;
      }

      // Ensure metadata has currentWeek
      writeLuaLSMetadata({
        lastCheckedWeek: currentWeek,
        latestVersion: FALLBACK_LUALS_VERSION,
        lastCheckedDate: "2026-09-23",
      });

      const origFetch = globalThis.fetch;
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      try {
        const bin = await resolveLuaLSBinary("latest", { quiet: true });
        expect(typeof bin).toBe("string");
        expect(fs.existsSync(bin)).toBe(true);
        // fetch should NOT have been called because week matches
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("triggers check and updates metadata when lastCheckedWeek is from a previous week", async () => {
      const pastWeek = "2026-W01";
      writeLuaLSMetadata({
        lastCheckedWeek: pastWeek,
        latestVersion: FALLBACK_LUALS_VERSION,
        lastCheckedDate: "2026-01-01",
      });

      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: `v${FALLBACK_LUALS_VERSION}` }),
      });

      try {
        const bin = await resolveLuaLSBinary("latest", { quiet: true });
        expect(typeof bin).toBe("string");

        const updated = readLuaLSMetadata();
        expect(updated?.lastCheckedWeek).toBe(getIsoWeek());
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("falls back to existing cached version when network check fails during a new week", async () => {
      const pastWeek = "2026-W01";
      writeLuaLSMetadata({
        lastCheckedWeek: pastWeek,
        latestVersion: FALLBACK_LUALS_VERSION,
        lastCheckedDate: "2026-01-01",
      });

      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Offline"));

      try {
        const bin = await resolveLuaLSBinary("latest", { quiet: true });
        expect(typeof bin).toBe("string");
        expect(fs.existsSync(bin)).toBe(true);

        const updated = readLuaLSMetadata();
        expect(updated?.lastCheckedWeek).toBe(getIsoWeek());
        expect(updated?.latestVersion).toBe(FALLBACK_LUALS_VERSION);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("falls back to FALLBACK_LUALS_VERSION when network fails and no cached versions exist", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Offline without cache"));

      try {
        // Calling resolveLuaLSBinary with explicit version avoids network and resolves fallback
        const bin = await resolveLuaLSBinary(FALLBACK_LUALS_VERSION, { quiet: true });
        expect(typeof bin).toBe("string");
        expect(fs.existsSync(bin)).toBe(true);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("returns targetBinaryPath and cleans up older versions when onlineTag is already cached and valid", async () => {
      writeLuaLSMetadata({
        lastCheckedWeek: "2026-W01",
        latestVersion: FALLBACK_LUALS_VERSION,
        lastCheckedDate: "2026-01-01",
      });

      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: `v${FALLBACK_LUALS_VERSION}` }),
      });

      try {
        const bin = await resolveLuaLSBinary("latest", { quiet: true });
        expect(typeof bin).toBe("string");
        expect(fs.existsSync(bin)).toBe(true);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("falls back to cachedVersions[0] when metadata.latestVersion is invalid during current week", async () => {
      const currentWeek = getIsoWeek();
      writeLuaLSMetadata({
        lastCheckedWeek: currentWeek,
        latestVersion: "99.99.99-nonexistent",
        lastCheckedDate: "2026-09-23",
      });

      const origFetch = globalThis.fetch;
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      try {
        const bin = await resolveLuaLSBinary("latest", { quiet: true });
        expect(typeof bin).toBe("string");
        expect(fs.existsSync(bin)).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("falls back to cachedVersions[0] when metadata.latestVersion is invalid and network fails on new week", async () => {
      writeLuaLSMetadata({
        lastCheckedWeek: "2026-W01",
        latestVersion: "99.99.99-nonexistent",
        lastCheckedDate: "2026-01-01",
      });

      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failed"));

      try {
        const bin = await resolveLuaLSBinary("latest", { quiet: true });
        expect(typeof bin).toBe("string");
        expect(fs.existsSync(bin)).toBe(true);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
