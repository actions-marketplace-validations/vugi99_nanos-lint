import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  FALLBACK_LUALS_VERSION,
  getIsoWeek,
  readLuaLSMetadata,
  resolveLuaLSBinary,
  writeLuaLSMetadata,
} from "../../src/luals.js";
import { isLiveTestsEnabled, seedCachedLuaLS } from "../helpers/live.js";

/** Records every `isBinaryValid()` spawn while delegating to the real call. */
const { execFileSyncCalls } = vi.hoisted(() => ({ execFileSyncCalls: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: actual,
    execFileSync: (file: string, args?: readonly string[], options?: unknown) => {
      execFileSyncCalls.push(String(file));
      return actual.execFileSync(file, args as string[], options as never);
    },
  };
});

describe.skipIf(!isLiveTestsEnabled())("resolveLuaLSBinary cache handling", () => {
  it("validates only the version recorded for the current week instead of every cached version", async () => {
    const baseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-warm-cache-"));
    try {
      const latest = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);
      // Older versions that must not be probed on the warm path.
      await seedCachedLuaLS(baseCacheDir, "3.19.0");
      await seedCachedLuaLS(baseCacheDir, "3.18.0");

      writeLuaLSMetadata(
        {
          lastCheckedWeek: getIsoWeek(),
          latestVersion: FALLBACK_LUALS_VERSION,
          lastCheckedDate: "2026-09-23",
        },
        baseCacheDir
      );

      execFileSyncCalls.length = 0;
      const resolved = await resolveLuaLSBinary("latest", { quiet: true, cacheDir: baseCacheDir });

      expect(resolved).toBe(latest);
      // One spawn in total: the fast path must not enumerate the cache.
      expect(execFileSyncCalls).toEqual([latest]);
    } finally {
      fs.rmSync(baseCacheDir, { recursive: true, force: true });
    }
  });

  it("keeps metadata and downloads inside an injected cache directory", async () => {
    const baseCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-injected-cache-"));
    try {
      const seeded = await seedCachedLuaLS(baseCacheDir, FALLBACK_LUALS_VERSION);

      const resolved = await resolveLuaLSBinary("latest", { quiet: true, cacheDir: baseCacheDir });

      expect(resolved).toBe(seeded);
      expect(fs.existsSync(path.join(baseCacheDir, "metadata.json"))).toBe(true);
      expect(readLuaLSMetadata(baseCacheDir)?.latestVersion).toBe(FALLBACK_LUALS_VERSION);
      expect(fs.existsSync(path.join(baseCacheDir, FALLBACK_LUALS_VERSION, ".complete"))).toBe(true);
    } finally {
      fs.rmSync(baseCacheDir, { recursive: true, force: true });
    }
  });
});
