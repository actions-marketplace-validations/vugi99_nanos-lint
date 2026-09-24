import { describe, expect, it, vi } from "vitest";
import { DEFAULT_REALM_MAPPINGS, resolveRealmMappings } from "../../src/config.js";
import { logger } from "../../src/logger.js";

describe("realm mapping resolution (#35)", () => {
  it("falls back to the conventional layout when nanos.realms is omitted", () => {
    const { enabled, mappings } = resolveRealmMappings({});
    expect(enabled).toBe(true);
    expect(mappings).toEqual([...DEFAULT_REALM_MAPPINGS]);
  });

  it("disables realm passes for an explicitly empty mapping", () => {
    const { enabled, mappings } = resolveRealmMappings({ nanos: { realms: {} } });
    expect(enabled).toBe(false);
    expect(mappings).toEqual([]);
  });

  it("accepts global as an alias of shared and normalizes separators", () => {
    const { enabled, mappings } = resolveRealmMappings({
      nanos: { realms: { "src\\server\\**": "server", "common/**": "global" } },
    });
    expect(enabled).toBe(true);
    expect(mappings).toEqual([
      { pattern: "src/server/**", realm: "server" },
      { pattern: "common/**", realm: "shared" },
    ]);
  });

  it("drops unusable entries with a warning", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { enabled, mappings } = resolveRealmMappings({
        nanos: {
          realms: {
            "src/server/**": "server",
            "src/broken/**": "banana" as unknown as "server",
            "": "client",
          },
        },
      });
      expect(enabled).toBe(true);
      expect(mappings).toEqual([{ pattern: "src/server/**", realm: "server" }]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"banana" is not one of'));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("unusable nanos.realms pattern"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("treats a malformed mapping value as absent", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { enabled, mappings } = resolveRealmMappings({
        nanos: { realms: ["Server/**"] as unknown as Record<string, "server"> },
      });
      expect(enabled).toBe(true);
      expect(mappings).toEqual([...DEFAULT_REALM_MAPPINGS]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("expected an object"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("disables realms when every declared entry is unusable", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { enabled } = resolveRealmMappings({
        nanos: { realms: { "src/**": "nope" as unknown as "server" } },
      });
      expect(enabled).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
