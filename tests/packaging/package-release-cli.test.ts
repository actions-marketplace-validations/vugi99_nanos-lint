import { describe, it, expect, vi, afterEach } from "vitest";
import { parseCliTag, resolveLuaLSReleaseVersion, main } from "../../scripts/package-release.js";

describe("package-release CLI helpers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("parseCliTag", () => {
    it("parses --tag <value>", () => {
      expect(parseCliTag(["--tag", "v2.8.2"], {})).toBe("v2.8.2");
    });

    it("parses --tag=<value>", () => {
      expect(parseCliTag(["--tag=v2.8.2"], {})).toBe("v2.8.2");
    });

    it("falls back to TAG_NAME environment variable", () => {
      expect(parseCliTag([], { TAG_NAME: "v2.8.2" })).toBe("v2.8.2");
    });

    it("prefers command line flag over TAG_NAME env", () => {
      expect(parseCliTag(["--tag", "v3.0.0"], { TAG_NAME: "v2.8.2" })).toBe("v3.0.0");
    });

    it("returns empty string when no tag is provided", () => {
      expect(parseCliTag([], {})).toBe("");
    });
  });

  describe("resolveLuaLSReleaseVersion", () => {
    it("returns sanitized version when GitHub API returns tag_name", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v3.19.2" }),
      } as Response);

      const ver = await resolveLuaLSReleaseVersion("dummy-token");
      expect(ver).toBe("3.19.2");
    });

    it("falls back to default 3.19.1 when GitHub API responds with non-ok status", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      const ver = await resolveLuaLSReleaseVersion();
      expect(ver).toBe("3.19.1");
    });

    it("falls back to default 3.19.1 when network throws", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

      const ver = await resolveLuaLSReleaseVersion();
      expect(ver).toBe("3.19.1");
    });
  });

  describe("main CLI runner", () => {
    it("throws error when tag is missing", async () => {
      await expect(main([], {})).rejects.toThrow(
        /--tag <name> or TAG_NAME environment variable is required/,
      );
    });
  });
});
