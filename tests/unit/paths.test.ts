import { describe, it, expect } from "vitest";
import { systemPaths } from "../../src/paths.js";
import { getCacheDir, FALLBACK_LUALS_VERSION } from "../../src/luals.js";
import path from "node:path";

describe("system paths resolution via env-paths", () => {
  it("resolves system paths structure with expected properties", () => {
    expect(systemPaths).toBeDefined();
    expect(typeof systemPaths.cache).toBe("string");
    expect(typeof systemPaths.temp).toBe("string");
    expect(typeof systemPaths.config).toBe("string");
    expect(typeof systemPaths.data).toBe("string");
    expect(typeof systemPaths.log).toBe("string");

    expect(systemPaths.cache.length).toBeGreaterThan(0);
    expect(systemPaths.temp.length).toBeGreaterThan(0);
    expect(systemPaths.cache).toContain("nanos-lint");
    expect(systemPaths.temp).toContain("nanos-lint");
  });

  it("getCacheDir uses systemPaths.cache for luals directory", () => {
    const defaultCache = getCacheDir();
    expect(defaultCache).toBe(path.join(systemPaths.cache, "luals", FALLBACK_LUALS_VERSION));

    const customVersionCache = getCacheDir("3.18.0");
    expect(customVersionCache).toBe(path.join(systemPaths.cache, "luals", "3.18.0"));
  });

  it("clears cache directory and returns path when cleanCache is called", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const { cleanCache } = await import("../../src/paths.js");

    const originalCache = systemPaths.cache;
    const tempTestCache = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-cache-test-"));
    try {
      (systemPaths as unknown as { cache: string }).cache = tempTestCache;
      const dummyFile = path.join(tempTestCache, "file.txt");
      fs.writeFileSync(dummyFile, "data");
      expect(fs.existsSync(dummyFile)).toBe(true);

      const cleared = cleanCache();
      expect(cleared).toBe(tempTestCache);
      expect(fs.existsSync(tempTestCache)).toBe(false);

      // Calling cleanCache again on non-existent cache returns null
      const secondCall = cleanCache();
      expect(secondCall).toBeNull();
    } finally {
      (systemPaths as unknown as { cache: string }).cache = originalCache;
      fs.rmSync(tempTestCache, { recursive: true, force: true });
    }
  });
});

