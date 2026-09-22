import { describe, it, expect } from "vitest";
import { fileUriToPath } from "../../src/types.js";

describe("fileUriToPath helper edge cases", () => {
  it("returns non-file URI strings as-is", () => {
    expect(fileUriToPath("https://example.com/file.lua")).toBe("https://example.com/file.lua");
    expect(fileUriToPath("relative/path/to/file.lua")).toBe("relative/path/to/file.lua");
  });

  it("handles valid file URIs across Windows and Unix", () => {
    if (process.platform === "win32") {
      expect(fileUriToPath("file:///c:/Users/test/file.lua")).toBe("C:/Users/test/file.lua");
    } else {
      expect(fileUriToPath("file:///usr/local/file.lua")).toBe("/usr/local/file.lua");
    }
  });

  it("handles fallback parsing when nodeFileURLToPath fails (malformed encoding or UNC)", () => {
    // Malformed percent encoding causes node:url fileURLToPath to throw URIError
    const malformed = fileUriToPath("file://%ZZ/C:/my/path.lua");
    expect(malformed).toContain("C:/my/path.lua");

    // UNC file URIs without leading triple slash
    const uncShare = fileUriToPath("file://server/share/file.lua");
    expect(uncShare).toBe("//server/share/file.lua");

    // Already has leading double slash in decoded
    const doubleSlash = fileUriToPath("file:////server/share/file.lua");
    expect(doubleSlash).toBe("//server/share/file.lua");

    // Unix path in fallback
    const unixFallback = fileUriToPath("file:///%ZZ/var/log/file.lua");
    expect(unixFallback).toBe("/%ZZ/var/log/file.lua");
  });
});
