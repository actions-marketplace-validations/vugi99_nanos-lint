import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectDeps, resolvePackageDependencies } from "../../src/deps.js";
import { logger } from "../../src/logger.js";
import type { LuaRCConfig } from "../../src/types.js";

describe("deps module", () => {
  describe("collectDeps", () => {
    it("handles empty or whitespace strings", () => {
      expect(collectDeps("")).toEqual([]);
      expect(collectDeps("   ")).toEqual([]);
      expect(collectDeps("", ["existing"])).toEqual(["existing"]);
    });

    it("accumulates trimmed values", () => {
      const first = collectDeps("  ../dep-a  ");
      expect(first).toEqual(["../dep-a"]);
      const second = collectDeps("dep-b", first);
      expect(second).toEqual(["../dep-a", "dep-b"]);
    });
  });

  describe("resolvePackageDependencies", () => {
    it("returns empty sets when no dependencies are specified", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-deps-empty-"));
      try {
        const res = resolvePackageDependencies(tempDir, {});
        expect(res.server).toEqual([]);
        expect(res.client).toEqual([]);
        expect(res.shared).toEqual([]);
        expect(res.all).toEqual([]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("logs a warning and skips missing dependency paths without failing", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-deps-missing-"));
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const config: LuaRCConfig = {
          nanos: { deps: ["./non-existent-dir", "./missing.lua"] },
        };
        const res = resolvePackageDependencies(tempDir, config, ["./also-missing"]);
        expect(res.server).toEqual([]);
        expect(res.client).toEqual([]);
        expect(res.shared).toEqual([]);
        expect(res.all).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Dependency path not found"));
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("logs a warning when nanos.deps is not an array or has non-string entries", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-deps-invalid-"));
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const invalidTypeConfig = {
          nanos: { deps: { "some/path": true } as unknown as string[] },
        };
        const res1 = resolvePackageDependencies(tempDir, invalidTypeConfig);
        expect(res1.all).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Ignoring nanos.deps: expected an array"),
        );

        warnSpy.mockClear();
        const invalidEntryConfig = {
          nanos: { deps: [123 as unknown as string, "   "] },
        };
        const res2 = resolvePackageDependencies(tempDir, invalidEntryConfig);
        expect(res2.all).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Skipping invalid nanos.deps entry"),
        );
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("correctly partitions standard package dependencies across realms", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-deps-realms-"));
      try {
        const depPkg = path.join(tempDir, "Packages", "my-dep");
        fs.mkdirSync(path.join(depPkg, "Server"), { recursive: true });
        fs.mkdirSync(path.join(depPkg, "Client"), { recursive: true });
        fs.mkdirSync(path.join(depPkg, "Shared"), { recursive: true });
        fs.writeFileSync(path.join(depPkg, "Server", "sv.lua"), "function DepSV() end");
        fs.writeFileSync(path.join(depPkg, "Client", "cl.lua"), "function DepCL() end");
        fs.writeFileSync(path.join(depPkg, "Shared", "sh.lua"), "function DepSH() end");
        fs.writeFileSync(path.join(depPkg, "Index.lua"), "return {}");

        const targetPkg = path.join(tempDir, "Packages", "target-pkg");
        fs.mkdirSync(targetPkg, { recursive: true });

        const config: LuaRCConfig = {
          nanos: { deps: ["../my-dep"] },
        };
        const res = resolvePackageDependencies(targetPkg, config);

        const normServerFolder = path.join(depPkg, "Server").replace(/\\/g, "/");
        const normClientFolder = path.join(depPkg, "Client").replace(/\\/g, "/");
        const normSharedFolder = path.join(depPkg, "Shared").replace(/\\/g, "/");
        const normIndexFile = path.join(depPkg, "Index.lua").replace(/\\/g, "/");
        const normDepRoot = depPkg.replace(/\\/g, "/");

        expect(res.all).toContain(normDepRoot);

        expect(res.server).toContain(normServerFolder);
        expect(res.server).toContain(normSharedFolder);
        expect(res.server).toContain(normIndexFile);
        expect(res.server).not.toContain(normClientFolder);

        expect(res.client).toContain(normClientFolder);
        expect(res.client).toContain(normSharedFolder);
        expect(res.client).toContain(normIndexFile);
        expect(res.client).not.toContain(normServerFolder);

        expect(res.shared).toContain(normSharedFolder);
        expect(res.shared).toContain(normIndexFile);
        expect(res.shared).not.toContain(normServerFolder);
        expect(res.shared).not.toContain(normClientFolder);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("supports single .lua definition files as dependencies and warns on non-lua files", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-deps-single-"));
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const defLua = path.join(tempDir, "types.lua");
        fs.writeFileSync(defLua, "---@class MyType");
        const readme = path.join(tempDir, "README.md");
        fs.writeFileSync(readme, "# Doc");

        const res = resolvePackageDependencies(tempDir, {}, [defLua, readme]);
        const normLua = defLua.replace(/\\/g, "/");

        expect(res.all).toContain(normLua);
        expect(res.server).toContain(normLua);
        expect(res.client).toContain(normLua);
        expect(res.shared).toContain(normLua);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Skipping non-Lua dependency file"),
        );
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("includes entire directory in all realms when dependency disables realms", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-deps-disabled-"));
      try {
        const depPkg = path.join(tempDir, "util-pkg");
        fs.mkdirSync(depPkg, { recursive: true });
        fs.writeFileSync(
          path.join(depPkg, ".luarc.json"),
          JSON.stringify({ nanos: { realms: {} } }),
        );
        fs.writeFileSync(path.join(depPkg, "math.lua"), "Math = {}");

        const res = resolvePackageDependencies(tempDir, { nanos: { deps: ["./util-pkg"] } });
        const normDep = depPkg.replace(/\\/g, "/");

        expect(res.server).toContain(normDep);
        expect(res.client).toContain(normDep);
        expect(res.shared).toContain(normDep);
        expect(res.all).toContain(normDep);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("respects custom nanos.realms in dependency package", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-deps-custom-"));
      try {
        const depPkg = path.join(tempDir, "custom-pkg");
        fs.mkdirSync(path.join(depPkg, "src", "srv"), { recursive: true });
        fs.mkdirSync(path.join(depPkg, "src", "cli"), { recursive: true });
        fs.writeFileSync(
          path.join(depPkg, ".luarc.json"),
          JSON.stringify({
            nanos: {
              realms: {
                "src/srv/**": "server",
                "src/cli/**": "client",
              },
            },
          }),
        );
        fs.writeFileSync(path.join(depPkg, "src", "srv", "a.lua"), "srv = 1");
        fs.writeFileSync(path.join(depPkg, "src", "cli", "b.lua"), "cli = 1");

        const res = resolvePackageDependencies(tempDir, { nanos: { deps: ["./custom-pkg"] } });
        const normSrv = path.join(depPkg, "src", "srv").replace(/\\/g, "/");
        const normCli = path.join(depPkg, "src", "cli").replace(/\\/g, "/");

        expect(res.server).toContain(normSrv);
        expect(res.server).not.toContain(normCli);
        expect(res.client).toContain(normCli);
        expect(res.client).not.toContain(normSrv);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("handles transitive dependencies and breaks circular dependencies", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-deps-transitive-"));
      try {
        const pkgA = path.join(tempDir, "pkgA");
        const pkgB = path.join(tempDir, "pkgB");
        const pkgC = path.join(tempDir, "pkgC");

        fs.mkdirSync(pkgA, { recursive: true });
        fs.mkdirSync(pkgB, { recursive: true });
        fs.mkdirSync(pkgC, { recursive: true });

        fs.writeFileSync(
          path.join(pkgA, ".luarc.json"),
          JSON.stringify({ nanos: { deps: ["../pkgB"] } }),
        );
        fs.writeFileSync(
          path.join(pkgB, ".luarc.json"),
          JSON.stringify({ nanos: { deps: ["../pkgC", "../pkgA"] } }),
        );
        fs.writeFileSync(path.join(pkgC, ".luarc.json"), JSON.stringify({ nanos: { deps: [] } }));

        const res = resolvePackageDependencies(pkgA, { nanos: { deps: ["../pkgB"] } });

        const normB = pkgB.replace(/\\/g, "/");
        const normC = pkgC.replace(/\\/g, "/");

        expect(res.all).toContain(normB);
        expect(res.all).toContain(normC);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
