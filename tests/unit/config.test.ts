import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  getPackageRoot,
  getDefinitionsDir,
  getDefaultAnnotationsPath,
  getDefaultTemplatePath,
  loadConfigFile,
  mergeConfigs,
  parseJsonc,
  stripJsonComments,
  stripTrailingSlashes,
} from "../../src/config.js";
import type { LuaRCConfig } from "../../src/types.js";

describe("config module", () => {
  it("resolves package root and definitions directory", () => {
    const root = getPackageRoot();
    expect(root).toBeDefined();
    expect(typeof root).toBe("string");

    const defDir = getDefinitionsDir();
    expect(defDir).toBeDefined();
    expect(defDir).toContain("annotations");

    const annotationsPath = getDefaultAnnotationsPath();
    expect(annotationsPath).toBeDefined();
    expect(annotationsPath).toContain("annotations.lua");

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
    expect(config.workspace?.ignoreDir).toContain("script");
    expect(config.workspace?.ignoreDir).toContain("node_modules");
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
      workspace: {
        ignoreDir: ["custom_ignore"],
      },
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
    expect(merged.workspace?.ignoreDir).toContain("custom_ignore");
    expect(merged.workspace?.ignoreDir).toContain("script");
    expect(merged.diagnostics?.globals).toContain("Server");
    expect(merged.diagnostics?.globals).toContain("MyCustomGlobal");
    expect(merged.diagnostics?.severity?.["undefined-field"]).toBe("Information");
    expect(merged.diagnostics?.disable).toContain("lowercase-global");
  });

  it("preserves default ignore rules when cliIgnore is passed", () => {
    const base: LuaRCConfig = {
      runtime: { version: "Lua 5.4" },
      workspace: {
        library: [],
        ignoreDir: ["script", "meta", "locale", "log", "node_modules"],
      },
    };

    const override: LuaRCConfig = {
      workspace: {
        ignoreDir: ["user_override_dir"],
      },
      files: {
        exclude: ["user_config_exclude.lua"],
      },
    };

    const fakeDefDir = "C:/mock/definitions";
    const merged = mergeConfigs(base, override, fakeDefDir, {
      cliIgnore: ["myfolder/hello-*.lua", "custom_folder", "other/**/*.lua"],
    });

    // Default structural rules MUST still be in ignoreDir
    expect(merged.workspace?.ignoreDir).toContain("script");
    expect(merged.workspace?.ignoreDir).toContain("meta");
    expect(merged.workspace?.ignoreDir).toContain("node_modules");
    expect(merged.workspace?.ignoreDir).toContain(".git");

    // Also user's override ignoreDir and plain directories from cliIgnore
    expect(merged.workspace?.ignoreDir).toContain("user_override_dir");
    expect(merged.workspace?.ignoreDir).toContain("custom_folder");

    // files.exclude must contain user override and CLI ignore patterns
    expect(merged.files?.exclude).toContain("user_config_exclude.lua");
    expect(merged.files?.exclude).toContain("myfolder/hello-*.lua");
    expect(merged.files?.exclude).toContain("custom_folder");
    expect(merged.files?.exclude).toContain("custom_folder/**");
    expect(merged.files?.exclude).toContain("other/**/*.lua");
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

  describe("stripTrailingSlashes", () => {
    it("removes trailing slashes", () => {
      expect(stripTrailingSlashes("myfolder/")).toBe("myfolder");
      expect(stripTrailingSlashes("myfolder///")).toBe("myfolder");
      expect(stripTrailingSlashes("myfolder")).toBe("myfolder");
      expect(stripTrailingSlashes("a/b//")).toBe("a/b");
      expect(stripTrailingSlashes("C:/dir/")).toBe("C:/dir");
      expect(stripTrailingSlashes("///")).toBe("");
      expect(stripTrailingSlashes("")).toBe("");
    });

    it("stays linear on slash-heavy input that would be quadratic for /\\/+$/", () => {
      // A trailing-slash regex has to retry its repetition at every offset when the
      // string does not end with a slash, which is quadratic in the input length.
      const pathological = "/".repeat(100_000) + "!";
      const started = Date.now();
      expect(stripTrailingSlashes(pathological)).toBe(pathological);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("keeps CLI ignore expansion working for patterns with trailing slashes", () => {
      const merged = mergeConfigs({}, {}, "C:/mock/definitions", {
        cliIgnore: ["myfolder///", "other"],
      });

      expect(merged.files?.exclude).toContain("myfolder/**");
      expect(merged.workspace?.ignoreDir).toContain("myfolder");
      expect(merged.workspace?.ignoreDir).toContain("other");
    });

    it("merges pathological CLI ignore patterns quickly (js/polynomial-redos regression)", () => {
      const pathological = ["/".repeat(100_000) + "!", "/".repeat(50_000) + "\\"];
      const started = Date.now();
      const merged = mergeConfigs({}, {}, "C:/mock/definitions", { cliIgnore: pathological });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(merged.files?.exclude).toContain(pathological[0]);
    });
  });
});
