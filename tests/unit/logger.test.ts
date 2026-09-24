import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Logger,
  logger,
  isValidLogLevel,
  parseLogLevel,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  LOG_LEVEL_PRIORITY,
} from "../../src/logger.js";

describe("logger module", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("constants and validation", () => {
    it("has the expected default log level", () => {
      expect(DEFAULT_LOG_LEVEL).toBe("warn");
    });

    it("defines valid log levels and priorities", () => {
      expect(LOG_LEVELS).toEqual(["silent", "error", "warn", "info", "debug"]);
      expect(LOG_LEVEL_PRIORITY.silent).toBe(0);
      expect(LOG_LEVEL_PRIORITY.error).toBe(1);
      expect(LOG_LEVEL_PRIORITY.warn).toBe(2);
      expect(LOG_LEVEL_PRIORITY.info).toBe(3);
      expect(LOG_LEVEL_PRIORITY.debug).toBe(4);
    });

    it("validates log levels correctly", () => {
      expect(isValidLogLevel("silent")).toBe(true);
      expect(isValidLogLevel("error")).toBe(true);
      expect(isValidLogLevel("warn")).toBe(true);
      expect(isValidLogLevel("info")).toBe(true);
      expect(isValidLogLevel("debug")).toBe(true);
      expect(isValidLogLevel("invalid")).toBe(false);
      expect(isValidLogLevel("")).toBe(false);
    });

    it("parses log level with case-insensitivity and fallbacks", () => {
      expect(parseLogLevel("DEBUG")).toBe("debug");
      expect(parseLogLevel("  InFo  ")).toBe("info");
      expect(parseLogLevel("warn")).toBe("warn");
      expect(parseLogLevel("ERROR")).toBe("error");
      expect(parseLogLevel("SILENT")).toBe("silent");
      expect(parseLogLevel("invalid")).toBe("warn");
      expect(parseLogLevel(null)).toBe("warn");
      expect(parseLogLevel(undefined)).toBe("warn");
    });
  });

  describe("Logger class", () => {
    it("defaults to warn level when no initial level or env is provided", () => {
      delete process.env.NANOS_LOG_LEVEL;
      delete process.env.LOG_LEVEL;
      const l = new Logger();
      expect(l.getLevel()).toBe("warn");
    });

    it("respects initial level in constructor", () => {
      const l = new Logger("debug");
      expect(l.getLevel()).toBe("debug");
    });

    it("reads NANOS_LOG_LEVEL from process.env", () => {
      process.env.NANOS_LOG_LEVEL = "debug";
      const l = new Logger();
      expect(l.getLevel()).toBe("debug");
    });

    it("ignores the generic LOG_LEVEL environment variable", () => {
      delete process.env.NANOS_LOG_LEVEL;
      process.env.LOG_LEVEL = "info";
      const l = new Logger();
      // LOG_LEVEL is commonly set by CI images for unrelated tooling and must
      // never silently change nanos-lint's verbosity.
      expect(l.getLevel()).toBe("warn");
    });

    it("reports whether command output is enabled", () => {
      const l = new Logger("warn");
      expect(l.isOutputEnabled()).toBe(true);

      l.setLevel("error");
      expect(l.isOutputEnabled()).toBe(true);

      l.setLevel("silent");
      expect(l.isOutputEnabled()).toBe(false);
    });

    it("allows updating log level via setLevel", () => {
      const l = new Logger("warn");
      l.setLevel("error");
      expect(l.getLevel()).toBe("error");
      // @ts-expect-error test invalid level argument at runtime
      l.setLevel("invalid-level");
      expect(l.getLevel()).toBe("error");
    });

    it("evaluates isEnabledFor correctly", () => {
      const l = new Logger("warn");
      expect(l.isEnabledFor("silent")).toBe(true);
      expect(l.isEnabledFor("error")).toBe(true);
      expect(l.isEnabledFor("warn")).toBe(true);
      expect(l.isEnabledFor("info")).toBe(false);
      expect(l.isEnabledFor("debug")).toBe(false);

      l.setLevel("debug");
      expect(l.isEnabledFor("info")).toBe(true);
      expect(l.isEnabledFor("debug")).toBe(true);

      l.setLevel("silent");
      expect(l.isEnabledFor("error")).toBe(false);
      expect(l.isEnabledFor("warn")).toBe(false);
    });

    it("logs according to level thresholds", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      const l = new Logger("warn");

      l.error("error message");
      l.warn("warn message");
      l.info("info message");
      l.debug("debug message");

      expect(errorSpy).toHaveBeenCalledWith("error message");
      expect(warnSpy).toHaveBeenCalledWith("warn message");
      expect(logSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();

      errorSpy.mockClear();
      warnSpy.mockClear();
      logSpy.mockClear();
      debugSpy.mockClear();

      l.setLevel("debug");
      l.info("info message");
      l.debug("debug message");

      expect(logSpy).toHaveBeenCalledWith("info message");
      expect(debugSpy).toHaveBeenCalledWith("debug message");

      errorSpy.mockClear();
      warnSpy.mockClear();
      logSpy.mockClear();
      debugSpy.mockClear();

      l.setLevel("silent");
      l.error("error message");
      l.warn("warn message");
      l.info("info message");
      l.debug("debug message");

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it("provides a singleton logger instance", () => {
      expect(logger).toBeInstanceOf(Logger);
    });
  });
});
