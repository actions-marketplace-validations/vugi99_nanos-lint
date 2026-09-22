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
});

