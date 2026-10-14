import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveAnnotations, type AnnotationsMetadata } from "../../src/annotations.js";
import { NanosLintError } from "../../src/errors.js";

/** Read-only and restricted cache handling (#59). */
describe("read-only annotations cache handling (#59)", () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-test-readonly-cache-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Failed to clean up tempBaseDir: ${err}`);
    }
  });

  describe("read-only cache handling (#59)", () => {
    const validAnnotations = "---@meta\n-- nanos world annotations\n" + " ".repeat(1200);
    let cacheSubdir: string;
    let cachedLua: string;

    /** Seeds a valid cached annotations.lua plus metadata with a stale lastChecked date. */
    const seedCache = (dirName: string, commitId: string): void => {
      cacheSubdir = path.join(tempBaseDir, `readonly-${dirName}`);
      fs.mkdirSync(cacheSubdir, { recursive: true });
      cachedLua = path.join(cacheSubdir, "annotations.lua");
      fs.writeFileSync(cachedLua, validAnnotations);
      const meta: AnnotationsMetadata = {
        commitId,
        lastChecked: "2026-01-01",
        date: { year: 2026, month: 1, day: 1 },
      };
      fs.writeFileSync(path.join(cacheSubdir, "metadata.json"), JSON.stringify(meta));
    };

    /** Makes every write inside the cache directory fail the way a read-only mount does. */
    const denyCacheWrites = (code: "EROFS" | "EACCES" = "EROFS") => {
      const denied = () => Object.assign(new Error(`${code}: read-only file system`), { code });
      const inCache = (p: unknown) => String(p).includes(path.basename(cacheSubdir));
      const originalWriteFileSync = fs.writeFileSync;
      const originalOpenSync = fs.openSync;

      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
        ...args: Parameters<typeof fs.writeFileSync>
      ) => {
        if (inCache(args[0])) {
          throw denied();
        }
        return originalWriteFileSync(...args);
      }) as typeof fs.writeFileSync);

      const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((
        ...args: Parameters<typeof fs.openSync>
      ) => {
        // Reads must keep working: only write modes are denied on a read-only mount.
        if (inCache(args[0]) && String(args[1] ?? "").includes("w")) {
          throw denied();
        }
        return originalOpenSync(...args);
      }) as typeof fs.openSync);

      return () => {
        writeSpy.mockRestore();
        openSpy.mockRestore();
      };
    };

    it("keeps using valid cached annotations when only the refresh date cannot be stored", async () => {
      seedCache("current", "a".repeat(40));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sha: "a".repeat(40) }),
      } as unknown as Response);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const restoreWrites = denyCacheWrites();
      try {
        const resolved = await resolveAnnotations({ cacheDir: cacheSubdir });
        expect(resolved).toBe(cachedLua);
        const warnings = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(warnings).toMatch(/read-only/i);
        expect(warnings).toContain("XDG_CACHE_HOME");
        // The cached definitions are preserved untouched.
        expect(fs.readFileSync(cachedLua, "utf-8")).toBe(validAnnotations);
      } finally {
        restoreWrites();
        warnSpy.mockRestore();
        globalThis.fetch = originalFetch;
      }
    });

    it("falls back to the valid cached copy when the cache cannot be refreshed", async () => {
      seedCache("stale", "b".repeat(40));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/commits/")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ sha: "e".repeat(40) }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(validAnnotations),
        } as unknown as Response);
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const restoreWrites = denyCacheWrites("EACCES");
      try {
        const resolved = await resolveAnnotations({ cacheDir: cacheSubdir });
        expect(resolved).toBe(cachedLua);
        const warnings = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(warnings).toMatch(/cannot refresh the annotations cache/i);
        expect(fs.readFileSync(cachedLua, "utf-8")).toBe(validAnnotations);
      } finally {
        restoreWrites();
        warnSpy.mockRestore();
        globalThis.fetch = originalFetch;
      }
    });

    it("reports a filesystem error with relocation guidance when no usable copy exists", async () => {
      seedCache("none", "c".repeat(40));
      fs.rmSync(cachedLua);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sha: "e".repeat(40) }),
      } as unknown as Response);

      const restoreWrites = denyCacheWrites();
      try {
        const failure = await resolveAnnotations({ cacheDir: cacheSubdir }).catch((e) => e);
        expect(failure).toBeInstanceOf(NanosLintError);
        expect((failure as NanosLintError).code).toBe("ERR_ANNOTATIONS_FS");
        expect((failure as NanosLintError).message).toMatch(/filesystem error/i);
        expect((failure as NanosLintError).remedy).toContain("XDG_CACHE_HOME");
        expect((failure as NanosLintError).remedy).toMatch(/process execution/i);
      } finally {
        restoreWrites();
        globalThis.fetch = originalFetch;
      }
    });

    it("still fails while offline when the cache holds no usable annotations", async () => {
      seedCache("offline", "d".repeat(40));
      fs.rmSync(cachedLua);

      await expect(resolveAnnotations({ cacheDir: cacheSubdir, offline: true })).rejects.toThrow(
        /no usable local annotations\.lua/i,
      );
    });
  });
});
