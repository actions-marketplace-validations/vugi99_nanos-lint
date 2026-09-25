import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sanitizeTag,
  sanitizeVersion,
  resolveAndPinAnnotations,
} from "../../scripts/package-release.js";

describe("annotations pinning and release input sanitization", () => {
  let tmpDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-pkg-annotations-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  it("sanitizeTag accepts valid semantic and release tags", () => {
    expect(sanitizeTag("v2.8.2")).toBe("v2.8.2");
    expect(sanitizeTag("1.0.0")).toBe("1.0.0");
    expect(sanitizeTag("v1.2.3-rc.1")).toBe("v1.2.3-rc.1");
  });

  it("sanitizeTag rejects path traversal or unsafe characters", () => {
    expect(() => sanitizeTag("")).toThrow(/invalid or unsafe release tag/);
    expect(() => sanitizeTag(".")).toThrow(/invalid or unsafe release tag/);
    expect(() => sanitizeTag("..")).toThrow(/invalid or unsafe release tag/);
    expect(() => sanitizeTag("../v1.0.0")).toThrow(/invalid or unsafe release tag/);
    expect(() => sanitizeTag("v1.0.0; rm -rf /")).toThrow(/invalid or unsafe release tag/);
    expect(() => sanitizeTag("v1.0/escaped")).toThrow(/invalid or unsafe release tag/);
  });

  it("sanitizeVersion accepts valid version strings", () => {
    expect(sanitizeVersion("3.19.1")).toBe("3.19.1");
    expect(sanitizeVersion("v3.19.1")).toBe("v3.19.1");
  });

  it("sanitizeVersion rejects unsafe version strings", () => {
    expect(() => sanitizeVersion("")).toThrow(/invalid or unsafe LuaLS version/);
    expect(() => sanitizeVersion("..")).toThrow(/invalid or unsafe LuaLS version/);
    expect(() => sanitizeVersion("../3.19.1")).toThrow(/invalid or unsafe LuaLS version/);
    expect(() => sanitizeVersion("3.19.1/bin")).toThrow(/invalid or unsafe LuaLS version/);
  });

  it("resolveAndPinAnnotations resolves commit SHA and downloads pinned annotations", async () => {
    const fakeCommit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const validAnnotations = "-- Nanos World Annotations\n" + "x = 1\n".repeat(300); // > 1000 bytes

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("commits/docgen-output")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ sha: fakeCommit })),
          json: () => Promise.resolve({ sha: fakeCommit }),
        } as unknown as Response);
      }
      if (String(url).includes(fakeCommit)) {
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          text: () => Promise.resolve(validAnnotations),
        } as unknown as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const dest = path.join(tmpDir, "annotations.lua");
    const commit = await resolveAndPinAnnotations(dest);

    expect(commit).toBe(fakeCommit);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, "utf-8")).toBe(validAnnotations);
  });

  it("resolveAndPinAnnotations rejects annotations smaller than minimum size", async () => {
    const fakeCommit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const tinyAnnotations = "-- tiny\n"; // < 1000 bytes

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("commits/docgen-output")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ sha: fakeCommit })),
          json: () => Promise.resolve({ sha: fakeCommit }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers(),
        text: () => Promise.resolve(tinyAnnotations),
      } as unknown as Response);
    });

    const dest = path.join(tmpDir, "annotations.lua");
    await expect(resolveAndPinAnnotations(dest)).rejects.toThrow(
      /appears truncated or invalid|outside permitted bounds/,
    );
  });
});
