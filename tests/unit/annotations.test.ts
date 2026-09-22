import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getTodayDateString,
  readAnnotationsMetadata,
  updateLastCheckedDate,
  downloadAndCacheAnnotations,
  resolveAnnotations,
  type AnnotationsMetadata,
} from "../../src/annotations.js";

describe("annotations management and date-based caching", () => {
  let tempBaseDir: string;
  let originalEnvAnnotations: string | undefined;
  let originalEnvPath: string | undefined;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-test-annotations-"));
    originalEnvAnnotations = process.env.NANOS_ANNOTATIONS;
    originalEnvPath = process.env.NANOS_ANNOTATIONS_PATH;
    delete process.env.NANOS_ANNOTATIONS;
    delete process.env.NANOS_ANNOTATIONS_PATH;
  });

  afterEach(() => {
    if (originalEnvAnnotations !== undefined) {
      process.env.NANOS_ANNOTATIONS = originalEnvAnnotations;
    } else {
      delete process.env.NANOS_ANNOTATIONS;
    }
    if (originalEnvPath !== undefined) {
      process.env.NANOS_ANNOTATIONS_PATH = originalEnvPath;
    } else {
      delete process.env.NANOS_ANNOTATIONS_PATH;
    }
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("formats today's date correctly with dateStr and dateObj", () => {
    const testDate = new Date(2026, 8, 22); // Month is 0-indexed: 8 = Sept
    const { dateStr, dateObj } = getTodayDateString(testDate);
    expect(dateStr).toBe("2026-09-22");
    expect(dateObj).toEqual({ year: 2026, month: 9, day: 22 });
  });

  it("reads and parses metadata correctly or returns null when missing/corrupted", () => {
    expect(readAnnotationsMetadata(tempBaseDir)).toBeNull();

    const metaFile = path.join(tempBaseDir, "metadata.json");
    const validMeta: AnnotationsMetadata = {
      commitId: "abcdef1234567890",
      lastChecked: "2026-09-22",
      date: { year: 2026, month: 9, day: 22 },
    };
    fs.writeFileSync(metaFile, JSON.stringify(validMeta), "utf-8");
    expect(readAnnotationsMetadata(tempBaseDir)).toEqual(validMeta);

    fs.writeFileSync(metaFile, "invalid-json", "utf-8");
    expect(readAnnotationsMetadata(tempBaseDir)).toBeNull();
  });

  it("updates last checked date without altering annotations.lua", () => {
    const dummyAnnotations = path.join(tempBaseDir, "annotations.lua");
    fs.writeFileSync(dummyAnnotations, "-- dummy content");

    const updated = updateLastCheckedDate("abc12345", tempBaseDir);
    expect(updated.commitId).toBe("abc12345");
    expect(readAnnotationsMetadata(tempBaseDir)?.commitId).toBe("abc12345");
    expect(fs.readFileSync(dummyAnnotations, "utf-8")).toBe("-- dummy content");
  });

  it("successfully downloads and writes annotations and metadata", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const parsed = new URL(urlStr);
      if (parsed.hostname === "raw.githubusercontent.com") {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("-- nanos world annotations mock\nreturn {}\n" + " ".repeat(1500)),
        } as unknown as Response);
      }
      return Promise.reject(new Error("Unexpected URL"));
    });

    try {
      const resultPath = await downloadAndCacheAnnotations("commit-111", tempBaseDir, { quiet: true });
      expect(fs.existsSync(resultPath)).toBe(true);
      expect(fs.readFileSync(resultPath, "utf-8")).toContain("nanos world annotations mock");

      const meta = readAnnotationsMetadata(tempBaseDir);
      expect(meta?.commitId).toBe("commit-111");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reverts cache state on download failure if previous cache existed", async () => {
    const existingAnnotations = path.join(tempBaseDir, "annotations.lua");
    fs.writeFileSync(existingAnnotations, "-- original good annotations");
    const existingMeta: AnnotationsMetadata = {
      commitId: "original-commit",
      lastChecked: "2026-09-01",
      date: { year: 2026, month: 9, day: 1 },
    };
    fs.writeFileSync(path.join(tempBaseDir, "metadata.json"), JSON.stringify(existingMeta));

    const originalFetch = globalThis.fetch;
    // Simulate network error during download
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network connection dropped"));

    try {
      await expect(
        downloadAndCacheAnnotations("new-commit", tempBaseDir, { quiet: true })
      ).rejects.toThrow(/Network connection dropped/);

      // Verify original files were restored
      expect(fs.readFileSync(existingAnnotations, "utf-8")).toBe("-- original good annotations");
      expect(readAnnotationsMetadata(tempBaseDir)?.commitId).toBe("original-commit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe("resolveAnnotations resolution precedence", () => {
    it("respects customPath option with highest priority", async () => {
      const customFile = path.join(tempBaseDir, "my-custom-annotations.lua");
      fs.writeFileSync(customFile, "-- custom file");

      const resolved = await resolveAnnotations({ customPath: customFile });
      expect(resolved).toBe(path.resolve(customFile));

      await expect(
        resolveAnnotations({ customPath: path.join(tempBaseDir, "non-existent.lua") })
      ).rejects.toThrow(/Custom annotations file not found/);
    });

    it("respects NANOS_ANNOTATIONS_PATH environment variable", async () => {
      const envCustomFile = path.join(tempBaseDir, "env-annotations.lua");
      fs.writeFileSync(envCustomFile, "-- env annotations");
      process.env.NANOS_ANNOTATIONS_PATH = envCustomFile;

      const resolved = await resolveAnnotations();
      expect(resolved).toBe(path.resolve(envCustomFile));

      process.env.NANOS_ANNOTATIONS_PATH = path.join(tempBaseDir, "missing-env.lua");
      await expect(resolveAnnotations()).rejects.toThrow(/Annotations file specified in environment not found/);
    });

    it("returns cached annotations immediately if checked today without making network calls", async () => {
      const cacheSubdir = path.join(tempBaseDir, "annotations");
      fs.mkdirSync(cacheSubdir, { recursive: true });

      const cachedLua = path.join(cacheSubdir, "annotations.lua");
      fs.writeFileSync(cachedLua, "-- today cached");

      const { dateStr, dateObj } = getTodayDateString();
      const meta: AnnotationsMetadata = {
        commitId: "sha-today",
        lastChecked: dateStr,
        date: dateObj,
      };
      fs.writeFileSync(path.join(cacheSubdir, "metadata.json"), JSON.stringify(meta));

      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      try {
        const resolved = await resolveAnnotations({ cacheDir: cacheSubdir });
        expect(resolved).toBe(cachedLua);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
