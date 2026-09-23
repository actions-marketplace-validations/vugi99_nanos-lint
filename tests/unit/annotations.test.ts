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
  fetchLatestCommitId,
  fetchRawAnnotationsContent,
  getRawAnnotationsUrl,
  RAW_ANNOTATIONS_URL,
  MIN_ANNOTATIONS_SIZE_BYTES,
  getCachedAnnotationsFilePath,
  getAnnotationsMetadataFilePath,
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
    } catch (err) {
      console.warn(`Failed to clean up tempBaseDir: ${err}`);
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
      fs.writeFileSync(cachedLua, "---@meta\n-- nanos world annotations\n" + " ".repeat(1200));

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

    it("respects NANOS_ANNOTATIONS environment variable as an alias", async () => {
      const envCustomFile = path.join(tempBaseDir, "env-annotations-alias.lua");
      fs.writeFileSync(envCustomFile, "-- env annotations alias");
      process.env.NANOS_ANNOTATIONS = envCustomFile;

      const resolved = await resolveAnnotations();
      expect(resolved).toBe(path.resolve(envCustomFile));

      process.env.NANOS_ANNOTATIONS = path.join(tempBaseDir, "missing-alias.lua");
      await expect(resolveAnnotations()).rejects.toThrow(/Annotations file specified in environment not found/);
    });

    it("reports filesystem cause rather than network error on EACCES/ENOSPC", async () => {
      const originalFetch = globalThis.fetch;
      // Network fails so it attempts fallback download
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fetch failed"));

      // Force cacheDir to fail with EACCES
      const mockDir = path.join(tempBaseDir, "readonly-cache");
      const fsError = new Error("permission denied") as NodeJS.ErrnoException;
      fsError.code = "EACCES";

      const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation((p: fs.PathLike) => {
        if (String(p).includes("readonly-cache")) {
          throw fsError;
        }
        return undefined;
      });

      try {
        await expect(
          resolveAnnotations({ cacheDir: mockDir })
        ).rejects.toThrow(/filesystem error|permission denied|EACCES/i);

        await expect(
          resolveAnnotations({ cacheDir: mockDir })
        ).rejects.not.toThrow(/check your network connection/i);
      } finally {
        mkdirSpy.mockRestore();
        globalThis.fetch = originalFetch;
      }
    });

    it("updates lastChecked to today on offline fallback with existing cache", async () => {
      const cacheSubdir = path.join(tempBaseDir, "annotations-offline");
      fs.mkdirSync(cacheSubdir, { recursive: true });

      const cachedLua = path.join(cacheSubdir, "annotations.lua");
      fs.writeFileSync(cachedLua, "---@meta\n-- nanos world annotations\n" + " ".repeat(1200));

      // Yesterday's metadata
      const oldMeta: AnnotationsMetadata = {
        commitId: "sha-old",
        lastChecked: "2026-09-01",
        date: { year: 2026, month: 9, day: 1 },
      };
      fs.writeFileSync(path.join(cacheSubdir, "metadata.json"), JSON.stringify(oldMeta));

      // Network fails (rate-limit 403 or offline)
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn().mockRejectedValue(new Error("Network offline"));
      globalThis.fetch = fetchSpy;

      try {
        const resolved = await resolveAnnotations({ cacheDir: cacheSubdir });
        expect(resolved).toBe(cachedLua);

        // Verify lastChecked was updated to today
        const updatedMeta = readAnnotationsMetadata(cacheSubdir);
        const { dateStr } = getTodayDateString();
        expect(updatedMeta?.lastChecked).toBe(dateStr);

        // A second call on the same day should now short-circuit without fetch
        fetchSpy.mockClear();
        const secondResolved = await resolveAnnotations({ cacheDir: cacheSubdir });
        expect(secondResolved).toBe(cachedLua);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("does not print 'commit unknown' when commitId is unknown", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((_url: string | URL | Request) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("---@meta\n-- nanos world annotations\n" + " ".repeat(1200)),
        } as unknown as Response);
      });

      try {
        await downloadAndCacheAnnotations("unknown", tempBaseDir, { quiet: false });
        for (const call of consoleSpy.mock.calls) {
          const msg = call.join(" ");
          expect(msg).not.toContain("commit unknown");
        }
      } finally {
        consoleSpy.mockRestore();
        globalThis.fetch = originalFetch;
      }
    });

    it("logs commit id when quiet is false and commitId is known", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((_url: string | URL | Request) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("---@meta\n-- nanos world annotations\n" + " ".repeat(1200)),
        } as unknown as Response);
      });

      try {
        const file = await downloadAndCacheAnnotations("abcdef1234567890", tempBaseDir, { quiet: false });
        expect(fs.existsSync(file)).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("falls back to unknown commitId when metadata is missing on offline cached fallback", async () => {
      const cacheSubdir = path.join(tempBaseDir, "no-meta-cache");
      fs.mkdirSync(cacheSubdir, { recursive: true });
      const cachedLua = path.join(cacheSubdir, "annotations.lua");
      fs.writeFileSync(cachedLua, "---@meta\n-- nanos world annotations\n" + " ".repeat(1200));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Offline"));

      try {
        const resolved = await resolveAnnotations({ cacheDir: cacheSubdir });
        expect(resolved).toBe(cachedLua);
        const meta = readAnnotationsMetadata(cacheSubdir);
        expect(meta?.commitId).toBe("unknown");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("sends GITHUB_TOKEN Authorization header in fetchLatestCommitId when available", async () => {
      const origToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "ghp_mock_token_12345";
      const originalFetch = globalThis.fetch;

      let capturedHeaders: Record<string, string> | undefined;
      globalThis.fetch = vi.fn().mockImplementation((_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ sha: "0123456789abcdef0123456789abcdef01234567" }),
        } as unknown as Response);
      });

      try {
        const commitId = await fetchLatestCommitId();
        expect(commitId).toBe("0123456789abcdef0123456789abcdef01234567");
        expect(capturedHeaders?.["Authorization"]).toBe("token ghp_mock_token_12345");
      } finally {
        if (origToken !== undefined) {
          process.env.GITHUB_TOKEN = origToken;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
        globalThis.fetch = originalFetch;
      }
    });

    it("handles fetchRawAnnotationsContent HTTP errors and truncated payloads", async () => {
      const originalFetch = globalThis.fetch;

      // 404 response
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      } as unknown as Response);

      await expect(fetchRawAnnotationsContent()).rejects.toThrow(/Failed to download annotations\.lua: 404 Not Found/);

      // Truncated payload (< 1000 characters)
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("-- short content"),
      } as unknown as Response);

      await expect(fetchRawAnnotationsContent()).rejects.toThrow(/Downloaded annotations\.lua appears truncated or invalid/);

      globalThis.fetch = originalFetch;
    });

    it("returns cached file when upstream commit matches metadata", async () => {
      const cacheSubdir = path.join(tempBaseDir, "commit-match-cache");
      fs.mkdirSync(cacheSubdir, { recursive: true });
      const cachedLua = path.join(cacheSubdir, "annotations.lua");
      fs.writeFileSync(cachedLua, "---@meta\n-- nanos world annotations\n" + " ".repeat(1200));

      const meta: AnnotationsMetadata = {
        commitId: "matching123456",
        lastChecked: "2026-01-01",
        date: { year: 2026, month: 1, day: 1 },
      };
      fs.writeFileSync(path.join(cacheSubdir, "metadata.json"), JSON.stringify(meta));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sha: "matching123456" }),
      } as unknown as Response);

      try {
        const resolved = await resolveAnnotations({ cacheDir: cacheSubdir });
        expect(resolved).toBe(cachedLua);
        const updatedMeta = readAnnotationsMetadata(cacheSubdir);
        const { dateStr } = getTodayDateString();
        expect(updatedMeta?.lastChecked).toBe(dateStr);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws network connection error on cold cache failure when not a filesystem error", async () => {
      const coldCacheDir = path.join(tempBaseDir, "cold-cache-non-fs-error");
      fs.mkdirSync(coldCacheDir, { recursive: true });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

      try {
        await expect(resolveAnnotations({ cacheDir: coldCacheDir })).rejects.toThrow(
          /Failed to resolve nanos world API annotations\. Please check your network connection/
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolves paths via getCachedAnnotationsFilePath and getAnnotationsMetadataFilePath", () => {
      expect(getCachedAnnotationsFilePath()).toContain("annotations.lua");
      expect(getAnnotationsMetadataFilePath()).toContain("metadata.json");
    });

    it("resolves explicit customPath or throws if not found", async () => {
      const customFile = path.join(tempBaseDir, "my-custom.lua");
      fs.writeFileSync(customFile, "-- custom");
      const resolved = await resolveAnnotations({ customPath: customFile });
      expect(resolved).toBe(path.resolve(customFile));

      await expect(resolveAnnotations({ customPath: "/nonexistent/custom.lua" })).rejects.toThrow(
        /Custom annotations file not found/
      );
    });

    it("validates customPath: rejects directories, empty files, and binary files (Issue #24)", async () => {
      const dirPath = path.join(tempBaseDir, "custom-dir");
      fs.mkdirSync(dirPath);
      await expect(resolveAnnotations({ customPath: dirPath })).rejects.toThrow(
        /Custom annotations path is not a file/
      );

      const emptyFile = path.join(tempBaseDir, "empty-custom.lua");
      fs.writeFileSync(emptyFile, "");
      await expect(resolveAnnotations({ customPath: emptyFile })).rejects.toThrow(
        /Custom annotations file is empty/
      );

      const binFile = path.join(tempBaseDir, "binary-custom.lua");
      fs.writeFileSync(binFile, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
      await expect(resolveAnnotations({ customPath: binFile })).rejects.toThrow(
        /appears to be a binary file/
      );
    });

    it("resolves annotations from NANOS_ANNOTATIONS_PATH or NANOS_ANNOTATIONS environment variable", async () => {
      const customEnvFile = path.join(tempBaseDir, "env-custom.lua");
      fs.writeFileSync(customEnvFile, "-- env custom");
      process.env.NANOS_ANNOTATIONS_PATH = customEnvFile;
      const resolved = await resolveAnnotations();
      expect(resolved).toBe(path.resolve(customEnvFile));

      delete process.env.NANOS_ANNOTATIONS_PATH;
      process.env.NANOS_ANNOTATIONS = customEnvFile;
      const resolved2 = await resolveAnnotations();
      expect(resolved2).toBe(path.resolve(customEnvFile));

      process.env.NANOS_ANNOTATIONS = "/nonexistent/env-annotations.lua";
      await expect(resolveAnnotations()).rejects.toThrow(
        /Annotations file specified in environment not found/
      );
    });

    it("validates env annotations: rejects directories, empty files, and binary files (Issue #24)", async () => {
      const dirPath = path.join(tempBaseDir, "env-dir");
      fs.mkdirSync(dirPath);
      process.env.NANOS_ANNOTATIONS_PATH = dirPath;
      await expect(resolveAnnotations()).rejects.toThrow(
        /Annotations path specified in environment is not a file/
      );

      const emptyFile = path.join(tempBaseDir, "env-empty.lua");
      fs.writeFileSync(emptyFile, "");
      process.env.NANOS_ANNOTATIONS_PATH = emptyFile;
      await expect(resolveAnnotations()).rejects.toThrow(
        /Annotations file specified in environment is empty/
      );

      const binFile = path.join(tempBaseDir, "env-bin.lua");
      fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02]));
      process.env.NANOS_ANNOTATIONS_PATH = binFile;
      await expect(resolveAnnotations()).rejects.toThrow(
        /appears to be a binary file/
      );
    });

    it("downloads and updates annotations when upstream commit changes", async () => {
      const cacheSubdir = path.join(tempBaseDir, "commit-changed-cache");
      fs.mkdirSync(cacheSubdir, { recursive: true });
      const cachedLua = path.join(cacheSubdir, "annotations.lua");
      fs.writeFileSync(cachedLua, "---@meta\n-- nanos world annotations\n" + " ".repeat(1200));

      const oldMeta: AnnotationsMetadata = {
        commitId: "old123456",
        lastChecked: "2026-01-01",
        date: { year: 2026, month: 1, day: 1 },
      };
      fs.writeFileSync(path.join(cacheSubdir, "metadata.json"), JSON.stringify(oldMeta));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("commits")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ sha: "abcdef0123456789" }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("---@meta\n-- nanos world annotations\n" + " ".repeat(1200)),
        } as unknown as Response);
      });

      try {
        const resolved = await resolveAnnotations({ cacheDir: cacheSubdir, quiet: true });
        expect(resolved).toBe(cachedLua);
        const updatedMeta = readAnnotationsMetadata(cacheSubdir);
        expect(updatedMeta?.commitId).toBe("abcdef0123456789");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("pins raw annotations download URL to resolved commit SHA (Issue #24)", async () => {
      expect(MIN_ANNOTATIONS_SIZE_BYTES).toBe(1000);
      expect(getRawAnnotationsUrl("abcdef0123456789")).toBe(
        "https://raw.githubusercontent.com/nanos-world/vscode-extension/abcdef0123456789/annotations.lua"
      );
      expect(getRawAnnotationsUrl("unknown")).toBe(RAW_ANNOTATIONS_URL);
      expect(getRawAnnotationsUrl(undefined)).toBe(RAW_ANNOTATIONS_URL);

      const originalFetch = globalThis.fetch;
      let fetchedUrl: string | undefined;
      globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
        fetchedUrl = String(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("---@meta\n-- nanos world annotations\n" + " ".repeat(1200)),
        } as unknown as Response);
      });

      try {
        await fetchRawAnnotationsContent("abcdef0123456789");
        expect(fetchedUrl).toContain("abcdef0123456789");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns bundled annotations when annotations.lua exists in package root", async () => {
      const root = path.join(tempBaseDir, "mock-root");
      fs.mkdirSync(root, { recursive: true });
      const fakeBundled = path.join(root, "annotations.lua");
      fs.writeFileSync(fakeBundled, "---@meta\n-- nanos world annotations\n" + " ".repeat(1200));

      const configModule = await import("../../src/config.js");
      const rootSpy = vi.spyOn(configModule, "getPackageRoot").mockReturnValue(root);

      try {
        const resolved = await resolveAnnotations();
        expect(resolved).toBe(fakeBundled);
      } finally {
        rootSpy.mockRestore();
      }
    });
  });
});

