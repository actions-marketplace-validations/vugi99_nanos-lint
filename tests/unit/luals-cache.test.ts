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
  getPlatformInfo,
  FALLBACK_LUALS_VERSION,
  type LuaLSMetadata,
} from "../../src/luals.js";
import { isLiveTestsEnabled, seedCachedLuaLS } from "../helpers/live.js";

const liveTestsEnabled = isLiveTestsEnabled();

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
      console.warn(
        `Failed to clean up tempBaseDir: ${err instanceof Error ? err.message : String(err)}`,
      );
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
          path.join(blocker, "child"),
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

      // Version 3: unparseable version name (inside tempBaseDir, never ../).
      const v3Dir = path.join(tempBaseDir, "invalid version");
      fs.mkdirSync(v3Dir, { recursive: true });
      fs.writeFileSync(path.join(v3Dir, ".complete"), "invalid version");

      // File instead of dir:
      fs.writeFileSync(path.join(tempBaseDir, "metadata.json"), "{}");
      // Dot directory (temp extraction):
      fs.mkdirSync(path.join(tempBaseDir, ".temp-extract"));

      expect(listCachedLuaLSVersions(tempBaseDir)).toEqual([]);
    });

    it.skipIf(!liveTestsEnabled)(
      "lists valid version when functional binary and complete marker exist",
      async () => {
        const seeded = await seedCachedLuaLS(tempBaseDir, FALLBACK_LUALS_VERSION);
        expect(fs.existsSync(seeded)).toBe(true);

        const versions = listCachedLuaLSVersions(tempBaseDir);
        expect(versions).toContain(FALLBACK_LUALS_VERSION);
      },
    );

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

  describe.skipIf(!liveTestsEnabled)("resolveLuaLSBinary weekly caching behavior", () => {
    /** Runs `fn` against a throw-away LuaLS cache base directory. */
    async function withIsolatedCache<T>(fn: (baseCacheDir: string) => Promise<T>): Promise<T> {
      const baseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-luals-resolve-"));
      try {
        return await fn(baseCacheDir);
      } finally {
        fs.rmSync(baseCacheDir, { recursive: true, force: true });
      }
    }

    /** Parses recorded requests so assertions match hosts and paths, never substrings. */
    function parseRequests(urls: string[]): { host: string; path: string }[] {
      return urls.map((raw) => {
        const parsed = new URL(raw);
        return { host: parsed.hostname, path: parsed.pathname };
      });
    }

    function isLuaLSArchiveRequest(request: { host: string; path: string }): boolean {
      return (
        request.host === "github.com" &&
        request.path.startsWith("/LuaLS/lua-language-server/releases/download/")
      );
    }

    function mockFetch(impl: (url: string) => Promise<unknown>): () => void {
      const originalFetch = globalThis.fetch;
      const spy = vi.fn((url: string | URL | Request) => impl(String(url)));
      globalThis.fetch = spy as unknown as typeof fetch;
      return () => {
        globalThis.fetch = originalFetch;
      };
    }

    it("reuses the cached latest version without calling fetch when lastCheckedWeek matches the current week", async () => {
      await withIsolatedCache(async (baseCacheDir) => {
        const seeded = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
        writeLuaLSMetadata(
          {
            lastCheckedWeek: getIsoWeek(),
            latestVersion: FALLBACK_LUALS_VERSION,
            lastCheckedDate: "2026-09-23",
          },
          baseCacheDir,
        );

        let fetchCalls = 0;
        const restoreFetch = mockFetch(() => {
          fetchCalls += 1;
          return Promise.reject(new Error("fetch must not be called when the week matches"));
        });

        try {
          const bin = await resolveLuaLSBinary("latest", { cacheDir: baseCacheDir });
          expect(bin).toBe(seeded);
          expect(fs.existsSync(bin)).toBe(true);
          expect(fetchCalls).toBe(0);
        } finally {
          restoreFetch();
        }
      });
    });

    it("triggers a weekly check and updates metadata when lastCheckedWeek is from a previous week", async () => {
      await withIsolatedCache(async (baseCacheDir) => {
        await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
        writeLuaLSMetadata(
          {
            lastCheckedWeek: "2026-W01",
            latestVersion: FALLBACK_LUALS_VERSION,
            lastCheckedDate: "2026-01-01",
          },
          baseCacheDir,
        );

        const requestedUrls: string[] = [];
        const restoreFetch = mockFetch((url) => {
          requestedUrls.push(url);
          return Promise.resolve({
            ok: true,
            json: async () => ({ tag_name: `v${FALLBACK_LUALS_VERSION}` }),
          });
        });

        try {
          const bin = await resolveLuaLSBinary("latest", { cacheDir: baseCacheDir });
          expect(typeof bin).toBe("string");
          expect(fs.existsSync(bin)).toBe(true);

          // The GitHub release API was consulted exactly once, without downloading.
          const requests = parseRequests(requestedUrls);
          expect(requests.filter((r) => r.host === "api.github.com")).toHaveLength(1);
          expect(requests.filter(isLuaLSArchiveRequest)).toHaveLength(0);

          const updated = readLuaLSMetadata(baseCacheDir);
          expect(updated?.lastCheckedWeek).toBe(getIsoWeek());
          expect(updated?.latestVersion).toBe(FALLBACK_LUALS_VERSION);
        } finally {
          restoreFetch();
        }
      });
    });

    it("falls back to the existing cached version when the network check fails during a new week", async () => {
      await withIsolatedCache(async (baseCacheDir) => {
        const seeded = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
        writeLuaLSMetadata(
          {
            lastCheckedWeek: "2026-W01",
            latestVersion: FALLBACK_LUALS_VERSION,
            lastCheckedDate: "2026-01-01",
          },
          baseCacheDir,
        );

        const restoreFetch = mockFetch(() => Promise.reject(new Error("Offline")));
        try {
          const bin = await resolveLuaLSBinary("latest", { cacheDir: baseCacheDir });
          expect(bin).toBe(seeded);

          const updated = readLuaLSMetadata(baseCacheDir);
          expect(updated?.lastCheckedWeek).toBe(getIsoWeek());
          expect(updated?.latestVersion).toBe(FALLBACK_LUALS_VERSION);
        } finally {
          restoreFetch();
        }
      });
    });

    it("targets FALLBACK_LUALS_VERSION and surfaces the network error when nothing is cached", async () => {
      await withIsolatedCache(async (baseCacheDir) => {
        const requestedUrls: string[] = [];
        const restoreFetch = mockFetch((url) => {
          requestedUrls.push(url);
          return Promise.reject(new Error("Offline without cache"));
        });

        try {
          await expect(
            resolveLuaLSBinary("latest", {
              cacheDir: baseCacheDir,
              // Force the network path: otherwise the shared test cache
              // legitimately satisfies the request.
              reuseExisting: false,
            }),
          ).rejects.toThrow(/Offline without cache/);
        } finally {
          restoreFetch();
        }

        // The fallback version was selected and used for the (failed) download attempt.
        expect(readLuaLSMetadata(baseCacheDir)?.latestVersion).toBe(FALLBACK_LUALS_VERSION);
        expect(
          parseRequests(requestedUrls).some(
            (r) =>
              isLuaLSArchiveRequest(r) &&
              r.path.startsWith(
                `/LuaLS/lua-language-server/releases/download/${FALLBACK_LUALS_VERSION}/`,
              ),
          ),
        ).toBe(true);
      });
    });

    it("returns the cached binary and cleans up older versions when the online tag is already cached", async () => {
      await withIsolatedCache(async (baseCacheDir) => {
        const seeded = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
        await seedCachedLuaLS(baseCacheDir, "3.19.0");
        writeLuaLSMetadata(
          {
            lastCheckedWeek: "2026-W01",
            latestVersion: FALLBACK_LUALS_VERSION,
            lastCheckedDate: "2026-01-01",
          },
          baseCacheDir,
        );

        const restoreFetch = mockFetch(() =>
          Promise.resolve({
            ok: true,
            json: async () => ({ tag_name: `v${FALLBACK_LUALS_VERSION}` }),
          }),
        );

        try {
          const bin = await resolveLuaLSBinary("latest", { cacheDir: baseCacheDir });
          expect(bin).toBe(seeded);
          expect(fs.existsSync(bin)).toBe(true);
          // The stale version directory was purged after the weekly check.
          expect(fs.existsSync(path.join(baseCacheDir, "3.19.0"))).toBe(false);
        } finally {
          restoreFetch();
        }
      });
    });

    it("falls back to the newest cached version when metadata.latestVersion is invalid during the current week", async () => {
      await withIsolatedCache(async (baseCacheDir) => {
        const seeded = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
        writeLuaLSMetadata(
          {
            lastCheckedWeek: getIsoWeek(),
            latestVersion: "99.99.99-nonexistent",
            lastCheckedDate: "2026-09-23",
          },
          baseCacheDir,
        );

        let fetchCalls = 0;
        const restoreFetch = mockFetch(() => {
          fetchCalls += 1;
          return Promise.reject(new Error("fetch must not be called during the current week"));
        });

        try {
          const bin = await resolveLuaLSBinary("latest", { cacheDir: baseCacheDir });
          expect(bin).toBe(seeded);
          expect(fetchCalls).toBe(0);
        } finally {
          restoreFetch();
        }
      });
    });

    it("falls back to the newest cached version when metadata.latestVersion is invalid and the network fails", async () => {
      await withIsolatedCache(async (baseCacheDir) => {
        const seeded = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
        writeLuaLSMetadata(
          {
            lastCheckedWeek: "2026-W01",
            latestVersion: "99.99.99-nonexistent",
            lastCheckedDate: "2026-01-01",
          },
          baseCacheDir,
        );

        const requestedUrls: string[] = [];
        const restoreFetch = mockFetch((url) => {
          requestedUrls.push(url);
          return Promise.reject(new Error("Network failed"));
        });

        try {
          const bin = await resolveLuaLSBinary("latest", { cacheDir: baseCacheDir });
          expect(bin).toBe(seeded);

          const updated = readLuaLSMetadata(baseCacheDir);
          expect(updated?.latestVersion).toBe(FALLBACK_LUALS_VERSION);
          // The cached version was reused instead of attempting a download.
          expect(parseRequests(requestedUrls).filter(isLuaLSArchiveRequest)).toHaveLength(0);
        } finally {
          restoreFetch();
        }
      });
    });
  });
});
