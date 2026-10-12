import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findPackageExports,
  buildExportBindingShadow,
  generatePackageExportBindings,
  isBindableGlobalName,
} from "../../src/package-exports.js";
import type { ResolvedDependencyRealms } from "../../src/deps.js";

const EMPTY_REALMS: ResolvedDependencyRealms = {
  server: [],
  client: [],
  shared: [],
  all: [],
};

describe("Package.Export recognition (#72)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-exports-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("findPackageExports", () => {
    it("finds a call and returns its literal, expression and span", () => {
      const source = 'local t = {}\nPackage.Export("Thing", t)\n';
      const calls = findPackageExports(source);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ name: "Thing", nameLiteral: '"Thing"', expression: "t" });
      expect(source.slice(calls[0]!.start, calls[0]!.end)).toBe('Package.Export("Thing", t)');
    });

    it("finds multiple calls and supports single quotes, spacing and long strings", () => {
      const source = [
        "Package . Export ( 'A' , one )",
        "local b = 2",
        "Package.Export([[B]], b)",
        'Package.Export("C", { x = 1 })',
      ].join("\n");
      const calls = findPackageExports(source);

      expect(calls.map((call) => call.name)).toEqual(["A", "B", "C"]);
      expect(calls[0]?.expression).toBe("one");
      expect(calls[2]?.expression).toBe("{ x = 1 }");
    });

    it("keeps nested parentheses and commas inside the exported expression", () => {
      const source = 'Package.Export("A", f(g(1, 2), { a = 3, b = 4 }))';
      const calls = findPackageExports(source);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.expression).toBe("f(g(1, 2), { a = 3, b = 4 })");
      expect(calls[0]?.end).toBe(source.length);
    });

    it("ignores calls hidden in comments and strings", () => {
      const source = [
        '-- Package.Export("Commented", x)',
        '--[[ Package.Export("BlockCommented", x) ]]',
        'local s = "Package.Export(\\"InString\\", x)"',
        "--[==[ Package.Export('LongComment', x) ]==]",
        'Package.Export("Real", x)',
      ].join("\n");
      const calls = findPackageExports(source);

      expect(calls.map((call) => call.name)).toEqual(["Real"]);
    });

    it("does not treat members of another table as the engine call", () => {
      const source = [
        'MyPackage.Export("A", a)',
        'obj:Package("B", b)',
        "local Package = { Export = function() end }",
        'Package.Export("C", c)',
      ].join("\n");

      expect(findPackageExports(source).map((call) => call.name)).toEqual(["C"]);
    });

    it("skips calls whose name is not a literal or whose value is missing", () => {
      const source = [
        "local name = 'Dynamic'",
        "Package.Export(name, value)",
        'Package.Export("OnlyName")',
        'Package.Export("Ok", 1)',
      ].join("\n");

      expect(findPackageExports(source).map((call) => call.name)).toEqual(["Ok"]);
    });

    it("returns nothing for an unterminated argument list", () => {
      expect(findPackageExports('Package.Export("Broken", value')).toEqual([]);
    });
  });

  describe("buildExportBindingShadow", () => {
    it("wraps the source and binds exported locals as globals", () => {
      const source = [
        "local VPerms = {}",
        "function VPerms.LoadPlayer(player) end",
        'Package.Export("VPerms", VPerms)',
      ].join("\n");
      const shadow = buildExportBindingShadow(source, "/deps/vperms/Server/Index.lua");

      expect(shadow).toContain("/deps/vperms/Server/Index.lua");
      expect(shadow).toContain("local _nanos_lint_exports = {}");
      expect(shadow).toContain("local function _nanos_lint_export_scope(...)");
      expect(shadow).toContain('_nanos_lint_exports["VPerms"] = VPerms');
      expect(shadow).toContain('VPerms = _nanos_lint_exports["VPerms"]');
      // The original statements survive verbatim inside the wrapper.
      expect(shadow).toContain("function VPerms.LoadPlayer(player) end");
      expect(shadow).not.toContain("Package.Export(");
    });

    it("binds every export once, ignoring duplicates and unbindable names", () => {
      const source = [
        'Package.Export("Dup", a)',
        'Package.Export("Dup", b)',
        'Package.Export("has-dash", c)',
        'Package.Export("end", d)',
        'Package.Export("Fine_1", e)',
      ].join("\n");
      const shadow = buildExportBindingShadow(source, "/deps/pkg/Shared/Index.lua");

      expect(shadow?.match(/^Dup = /gm)).toHaveLength(1);
      expect(shadow?.match(/^Fine_1 = /gm)).toHaveLength(1);
      expect(shadow).not.toContain("has-dash = ");
      expect(shadow).not.toContain("end = _nanos_lint_exports");
    });

    it("returns null when the file exports nothing bindable", () => {
      expect(buildExportBindingShadow("local a = 1\n", "/deps/pkg/a.lua")).toBeNull();
      expect(buildExportBindingShadow("Package.Export(name, value)", "/deps/pkg/b.lua")).toBeNull();
    });
  });

  it("classifies bindable global names", () => {
    expect(isBindableGlobalName("VPerms")).toBe(true);
    expect(isBindableGlobalName("_private1")).toBe(true);
    expect(isBindableGlobalName("1leading")).toBe(false);
    expect(isBindableGlobalName("has-dash")).toBe(false);
    expect(isBindableGlobalName("function")).toBe(false);
  });

  describe("generatePackageExportBindings", () => {
    /** Creates a dependency package layout and returns its root. */
    const createPackage = (files: Record<string, string>): string => {
      const root = fs.mkdtempSync(path.join(tempDir, "pkg-"));
      for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      return root;
    };

    it("mirrors realm scripts into generated libraries for the matching realms only", () => {
      const pkg = createPackage({
        "Server/Index.lua": 'local VPerms = {}\nPackage.Export("VPerms", VPerms)\n',
        "Shared/Config.lua": 'local Config = {}\nPackage.Export("PkgConfig", Config)\n',
        "Server/Plain.lua": "local x = 1\n",
        "Client/Ignored.txt": 'Package.Export("NotLua", x)',
      });
      const bindings = generatePackageExportBindings(
        {
          server: [path.join(pkg, "Server"), path.join(pkg, "Shared")],
          client: [path.join(pkg, "Shared")],
          shared: [path.join(pkg, "Shared")],
          all: [pkg],
        },
        { tempRoot: tempDir },
      );

      try {
        expect(bindings.directory).not.toBeNull();
        expect(bindings.server).toHaveLength(2);
        expect(bindings.client).toHaveLength(1);
        expect(bindings.shared).toHaveLength(1);
        expect(bindings.all).toHaveLength(2);
        expect(bindings.client[0]).toBe(bindings.shared[0]);

        const serverSources = bindings.server.map((file) => fs.readFileSync(file, "utf-8"));
        expect(serverSources.some((content) => content.includes("VPerms = "))).toBe(true);
        expect(serverSources.some((content) => content.includes("PkgConfig = "))).toBe(true);
        // The client pass must never see server-only exports.
        const clientSource = fs.readFileSync(bindings.client[0]!, "utf-8");
        expect(clientSource).not.toContain("VPerms = ");
      } finally {
        bindings.cleanup();
      }
      expect(fs.existsSync(bindings.directory!)).toBe(false);
    });

    it("skips hidden directories and Lua files without exports", () => {
      const pkg = createPackage({
        ".hidden/Index.lua": 'Package.Export("Hidden", x)\n',
        "node_modules/dep/Index.lua": 'Package.Export("Dep", x)\n',
        "Server/Plain.lua": "local x = 1\n",
      });
      const bindings = generatePackageExportBindings(
        { ...EMPTY_REALMS, server: [pkg], all: [pkg] },
        { tempRoot: tempDir },
      );

      expect(bindings.all).toEqual([]);
      expect(bindings.directory).toBeNull();
      bindings.cleanup();
    });

    it("accepts explicit dependency Lua files and missing paths", () => {
      const pkg = createPackage({
        "Exports.lua": 'local Api = {}\nPackage.Export("Api", Api)\n',
      });
      const bindings = generatePackageExportBindings(
        {
          ...EMPTY_REALMS,
          all: [path.join(pkg, "Exports.lua"), path.join(pkg, "missing.lua")],
        },
        { tempRoot: tempDir },
      );

      try {
        expect(bindings.all).toHaveLength(1);
        expect(fs.readFileSync(bindings.all[0]!, "utf-8")).toContain("Api = _nanos_lint_exports");
      } finally {
        bindings.cleanup();
      }
    });

    it("returns an empty result without creating a directory when there is nothing to mirror", () => {
      const bindings = generatePackageExportBindings(EMPTY_REALMS, { tempRoot: tempDir });

      expect(bindings).toMatchObject({ server: [], client: [], shared: [], all: [] });
      expect(bindings.directory).toBeNull();
      expect(() => bindings.cleanup()).not.toThrow();
    });
  });
});
