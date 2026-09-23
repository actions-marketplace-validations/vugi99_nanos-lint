import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  formatBytes,
  getDirectorySize,
  getCacheStatus,
  formatCacheStatusPretty,
  runCLI,
} from "../../src/index.js";
import * as pathsModule from "../../src/paths.js";

describe("Cache Status Inspection and Reporting", () => {
  describe("formatBytes utility", () => {
    it("formats 0 and negative or invalid values", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(-100)).toBe("0 B");
      expect(formatBytes(NaN)).toBe("0 B");
    });

    it("formats byte values across scales", () => {
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(1536)).toBe("1.50 KB");
      expect(formatBytes(1488978)).toBe("1.42 MB");
      expect(formatBytes(44564480)).toBe("42.5 MB");
      expect(formatBytes(90596966)).toBe("86.4 MB");
      expect(formatBytes(2147483648)).toBe("2.00 GB");
    });
  });

  describe("getDirectorySize utility", () => {
    it("returns 0 for nonexistent paths", () => {
      expect(getDirectorySize("/nonexistent/random/path")).toBe(0);
    });

    it("calculates size for single file", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-size-test-"));
      try {
        const filePath = path.join(tempDir, "sample.txt");
        fs.writeFileSync(filePath, "Hello World!", "utf-8"); // 12 bytes
        expect(getDirectorySize(filePath)).toBe(12);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("recursively calculates total size for directory structure", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-size-test-"));
      try {
        const subDir = path.join(tempDir, "sub");
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, "file1.txt"), "12345", "utf-8"); // 5 bytes
        fs.writeFileSync(path.join(subDir, "file2.txt"), "67890", "utf-8"); // 5 bytes
        expect(getDirectorySize(tempDir)).toBe(10);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("getCacheStatus and formatCacheStatusPretty", () => {
    it("handles empty or nonexistent cache directory", () => {
      const nonExistent = path.join(os.tmpdir(), `nonexistent-cache-${Date.now()}`);
      const report = getCacheStatus(nonExistent);

      expect(report.cacheDirectory).toBe(nonExistent);
      expect(report.totalSize).toBe(0);
      expect(report.totalSizeFormatted).toBe("0 B");
      expect(report.luals.versions).toEqual([]);
      expect(report.annotations.status).toBe("missing");

      const pretty = formatCacheStatusPretty(report);
      expect(pretty).toContain("Total Disk Usage:  0 B");
      expect(pretty).toContain("Weekly Check:   none");
      expect(pretty).toContain("Target Version: none");
      expect(pretty).toContain("Cached Copies:  none");
      expect(pretty).toContain("Status:         Not cached");
    });

    it("inspects populated cache directory with metadata and versions", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-status-test-"));
      try {
        // LuaLS metadata
        fs.writeFileSync(
          path.join(tempDir, "metadata.json"),
          JSON.stringify({
            lastCheckedWeek: "2026-W39",
            lastCheckedDate: "2026-09-23",
            latestVersion: "3.19.1",
          }),
          "utf-8"
        );

        // LuaLS version directory with dummy executable
        const vDir = path.join(tempDir, "3.19.1");
        const binDir = path.join(vDir, "bin");
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(vDir, ".complete"), "3.19.1", "utf-8");
        const binFile = path.join(binDir, process.platform === "win32" ? "lua-language-server.exe" : "lua-language-server");
        fs.writeFileSync(binFile, Buffer.alloc(120_000));

        // Annotations
        const annDir = path.join(tempDir, "annotations");
        fs.mkdirSync(annDir, { recursive: true });
        fs.writeFileSync(
          path.join(annDir, "metadata.json"),
          JSON.stringify({
            commitId: "8f3a9b2c12345678",
            lastChecked: "2026-09-23",
            date: { year: 2026, month: 9, day: 23 },
          }),
          "utf-8"
        );
        fs.writeFileSync(
          path.join(annDir, "annotations.lua"),
          "-- nanos world API definitions\n" + "x".repeat(2000),
          "utf-8"
        );

        const report = getCacheStatus(tempDir);
        expect(report.totalSize).toBeGreaterThan(120_000);
        expect(report.luals.weeklyCheck).toBe("2026-W39");
        expect(report.luals.targetVersion).toBe("3.19.1");
        expect(report.annotations.status).toBe("valid");
        expect(report.annotations.commitId).toBe("8f3a9b2c12345678");

        const pretty = formatCacheStatusPretty(report);
        expect(pretty).toContain("Weekly Check:   2026-W39 (last checked: 2026-09-23)");
        expect(pretty).toContain("Target Version: 3.19.1");
        expect(pretty).toContain("Commit SHA:     8f3a9b2c (docgen-output)");
        expect(pretty).toContain("Last Checked:   2026-09-23");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("CLI cache commands execution", () => {
    it("runs 'cache status' and 'cache info' in pretty mode", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const codeStatus = await runCLI(["cache", "status"]);
        expect(codeStatus).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("nanos-lint Cache Status"));

        logSpy.mockClear();
        const codeInfo = await runCLI(["cache", "info"]);
        expect(codeInfo).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("nanos-lint Cache Status"));

        logSpy.mockClear();
        const codeAlias = await runCLI(["cache-status"]);
        expect(codeAlias).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("nanos-lint Cache Status"));

        logSpy.mockClear();
        const codeBare = await runCLI(["cache"]);
        expect(codeBare).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("nanos-lint Cache Status"));
      } finally {
        logSpy.mockRestore();
      }
    });

    it("runs 'cache status --json' and 'cache-status --json' in structured mode", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const codeJson = await runCLI(["cache", "status", "--json"]);
        expect(codeJson).toBe(0);
        expect(logSpy).toHaveBeenCalled();
        const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1];
        expect(lastCall).toBeDefined();
        const parsed = JSON.parse(lastCall![0] as string);
        expect(parsed).toHaveProperty("cacheDirectory");
        expect(parsed).toHaveProperty("totalSize");
        expect(parsed).toHaveProperty("luals");
        expect(parsed).toHaveProperty("annotations");

        logSpy.mockClear();
        const codeAliasJson = await runCLI(["cache-status", "--json"]);
        expect(codeAliasJson).toBe(0);
        const parsedAlias = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(parsedAlias).toHaveProperty("cacheDirectory");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("runs 'cache clean' subcommand", async () => {
      const cleanSpy = vi.spyOn(pathsModule, "cleanCache").mockReturnValue("/mock/cache");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const codeClean = await runCLI(["cache", "clean"]);
        expect(codeClean).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[cache] Cleared cache at: /mock/cache"));
      } finally {
        cleanSpy.mockRestore();
        logSpy.mockRestore();
      }
    });
  });
});

