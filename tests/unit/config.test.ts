import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  getPackageRoot,
  getDefinitionsDir,
  getDefaultTemplatePath,
  loadConfigFile,
  mergeConfigs,
  parseJsonc,
  stripJsonComments,
} from "../../src/config.js";
import type { LuaRCConfig } from "../../src/types.js";

describe("config module", () => {
  it("resolves package root and definitions directory", () => {
    const root = getPackageRoot();
    expect(root).toBeDefined();
    expect(typeof root).toBe("string");

    const defDir = getDefinitionsDir();
    expect(defDir).toBe(path.join(root, "definitions"));

    const template = getDefaultTemplatePath();
    expect(template).toBe(path.join(root, "templates", ".luarc.json"));
  });

  it("loads and parses the default template", () => {
    const templatePath = getDefaultTemplatePath();
    const config = loadConfigFile(templatePath);
    expect(config.runtime?.version).toBe("Lua 5.4");
    expect(config.diagnostics?.enable).toBe(true);
    expect(config.diagnostics?.globals).toContain("Package");
    expect(config.diagnostics?.globals).toContain("Server");
  });

  it("merges custom workspace config while preserving nanos definitions", () => {
    const base: LuaRCConfig = {
      runtime: { version: "Lua 5.4" },
      workspace: { library: [] },
      diagnostics: {
        globals: ["Server", "Client"],
        severity: { "undefined-field": "Warning" },
      },
    };

    const override: LuaRCConfig = {
      diagnostics: {
        globals: ["MyCustomGlobal"],
        severity: { "undefined-field": "Information" },
        disable: ["lowercase-global"],
      },
    };

    const fakeDefDir = "C:/mock/definitions";
    const merged = mergeConfigs(base, override, fakeDefDir);

    expect(merged.runtime?.version).toBe("Lua 5.4");
    expect(merged.workspace?.library).toContain(fakeDefDir);
    expect(merged.diagnostics?.globals).toContain("Server");
    expect(merged.diagnostics?.globals).toContain("MyCustomGlobal");
    expect(merged.diagnostics?.severity?.["undefined-field"]).toBe("Information");
    expect(merged.diagnostics?.disable).toContain("lowercase-global");
  });

  it("strips JSON comments and trailing commas correctly", () => {
    const jsonc = `{
      // Single line comment
      "string": "https://example.com/api", // comment after value
      /* Multi-line
         comment */
      "nested": {
        "quotedComment": "/* not a comment */ // still string",
        "trailing": 42,
      },
      "list": [
        "item1",
        "item2",
      ],
    }`;

    const stripped = stripJsonComments(jsonc);
    expect(stripped).not.toContain("// Single line comment");
    expect(stripped).not.toContain("/* Multi-line");
    expect(stripped).toContain("https://example.com/api");

    const parsed = parseJsonc<{
      string: string;
      nested: { quotedComment: string; trailing: number };
      list: string[];
    }>(jsonc);

    expect(parsed.string).toBe("https://example.com/api");
    expect(parsed.nested.quotedComment).toBe("/* not a comment */ // still string");
    expect(parsed.nested.trailing).toBe(42);
    expect(parsed.list).toEqual(["item1", "item2"]);
  });

  it("handles empty comments and escaped strings in JSONC", () => {
    const jsonc = `{
      "escaped": "value with \\"quotes\\" and \\\\ backslash",
      /**/
      //
      "valid": true,
    }`;

    const parsed = parseJsonc<{ escaped: string; valid: boolean }>(jsonc);
    expect(parsed.escaped).toBe('value with "quotes" and \\ backslash');
    expect(parsed.valid).toBe(true);
  });
});
