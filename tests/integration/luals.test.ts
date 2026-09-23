import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveWorkspaceConfig, getPackageRoot, initWorkspace } from "../../src/config.js";
import { runLuaLSCheck } from "../../src/luals.js";
import {
  getSharedAnnotations,
  getSharedLuaLSBinary,
  isLiveTestsEnabled,
} from "../helpers/live.js";

describe.skipIf(!isLiveTestsEnabled())("LuaLS live integration tests", () => {
  const root = getPackageRoot();
  const passDir = path.join(root, "tests", "pass");
  const failDir = path.join(root, "tests", "fail");

  beforeAll(async () => {
    // Cache hits from the global setup; ensures fixtures are ready.
    await Promise.all([getSharedLuaLSBinary(), getSharedAnnotations()]);
  }, 120000);

  it("passes cleanly on valid nanos world test suite", async () => {
    const resolved = resolveWorkspaceConfig(passDir);
    try {
      const result = await runLuaLSCheck(passDir, resolved.configPath, {
        path: passDir,
        checklevel: "Warning",
      });
      expect(result.passed).toBe(true);
      expect(result.totalProblems).toBe(0);
    } finally {
      if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
        fs.unlinkSync(resolved.configPath);
      }
    }
  });

  it("detects parameter type mismatch in type_mismatch.lua", async () => {
    const file = path.join(failDir, "type_mismatch.lua");
    const resolved = resolveWorkspaceConfig(file);
    try {
      const result = await runLuaLSCheck(file, resolved.configPath, {
        path: file,
        checklevel: "Warning",
      });
      expect(result.passed).toBe(false);
      expect(result.totalProblems).toBeGreaterThan(0);

      const allDiags = Object.values(result.diagnostics).flat();
      const hasTypeMismatch = allDiags.some((d) => d.code === "param-type-mismatch");
      expect(hasTypeMismatch).toBe(true);
    } finally {
      if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
        fs.unlinkSync(resolved.configPath);
      }
    }
  });

  it("detects undefined field in undefined_field.lua", async () => {
    const file = path.join(failDir, "undefined_field.lua");
    const resolved = resolveWorkspaceConfig(file);
    try {
      const result = await runLuaLSCheck(file, resolved.configPath, {
        path: file,
        checklevel: "Warning",
      });
      expect(result.passed).toBe(false);

      const allDiags = Object.values(result.diagnostics).flat();
      const hasUndefinedField = allDiags.some((d) => d.code === "undefined-field");
      expect(hasUndefinedField).toBe(true);
    } finally {
      if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
        fs.unlinkSync(resolved.configPath);
      }
    }
  });

  it("detects undefined global in undefined_global.lua", async () => {
    const file = path.join(failDir, "undefined_global.lua");
    const resolved = resolveWorkspaceConfig(file);
    try {
      const result = await runLuaLSCheck(file, resolved.configPath, {
        path: file,
        checklevel: "Warning",
      });
      expect(result.passed).toBe(false);

      const allDiags = Object.values(result.diagnostics).flat();
      const hasUndefinedGlobal = allDiags.some((d) => d.code === "undefined-global");
      expect(hasUndefinedGlobal).toBe(true);
    } finally {
      if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
        fs.unlinkSync(resolved.configPath);
      }
    }
  });

  it("detects syntax errors in syntax_error.lua", async () => {
    const file = path.join(failDir, "syntax_error.lua");
    const resolved = resolveWorkspaceConfig(file);
    try {
      const result = await runLuaLSCheck(file, resolved.configPath, {
        path: file,
        checklevel: "Warning",
      });
      expect(result.passed).toBe(false);
      expect(result.totalProblems).toBeGreaterThan(0);
    } finally {
      if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
        fs.unlinkSync(resolved.configPath);
      }
    }
  });

  it("confirms Issue #20 regression fix for VehicleWheeled:SetEngineSetup", async () => {
    const file = path.join(failDir, "issue20_regression.lua");
    const resolved = resolveWorkspaceConfig(file);
    try {
      const result = await runLuaLSCheck(file, resolved.configPath, {
        path: file,
        checklevel: "Warning",
      });
      expect(result.passed).toBe(false);

      const allDiags = Object.values(result.diagnostics).flat();
      const hasIssue20Warning = allDiags.some(
        (d) =>
          d.code === "param-type-mismatch" &&
          d.message.includes("Cannot assign `string` to parameter `integer?`")
      );
      expect(hasIssue20Warning).toBe(true);
    } finally {
      if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
        fs.unlinkSync(resolved.configPath);
      }
    }
  });

  it("respects workspace .luarc.json diagnostic overrides with negative control and BOM support", async () => {
    const tempWorkspace = path.join(os.tmpdir(), `nanos-override-test-${Date.now()}`);
    fs.mkdirSync(tempWorkspace, { recursive: true });

    try {
      // Create a test file that triggers undefined-field
      const script = `
        local char = Character(Vector(0,0,0), Rotator(0,0,0), "nanos-world::SK_Mannequin")
        char:SomeNonExistentMethod()
      `;
      fs.writeFileSync(path.join(tempWorkspace, "override_test.lua"), script, "utf-8");

      // Negative control: without .luarc.json override, undefined-field must be reported
      const baseResolved = resolveWorkspaceConfig(tempWorkspace);
      try {
        const baseResult = await runLuaLSCheck(tempWorkspace, baseResolved.configPath, {
          path: tempWorkspace,
          checklevel: "Warning",
        });
        expect(baseResult.passed).toBe(false);
        const diags = Object.values(baseResult.diagnostics).flat();
        expect(diags.some((d) => d.code === "undefined-field")).toBe(true);
      } finally {
        if (baseResolved.isTemp && fs.existsSync(baseResolved.configPath)) {
          fs.unlinkSync(baseResolved.configPath);
        }
      }

      // Create a workspace .luarc.json disabling undefined-field (with leading UTF-8 BOM)
      const workspaceConfig = {
        diagnostics: {
          disable: ["undefined-field"],
        },
      };
      fs.writeFileSync(
        path.join(tempWorkspace, ".luarc.json"),
        "\uFEFF" + JSON.stringify(workspaceConfig),
        "utf-8"
      );

      const resolved = resolveWorkspaceConfig(tempWorkspace);
      try {
        const result = await runLuaLSCheck(tempWorkspace, resolved.configPath, {
          path: tempWorkspace,
          checklevel: "Warning",
        });

        // undefined-field should be disabled, so totalProblems should be 0
        expect(result.passed).toBe(true);
        expect(result.totalProblems).toBe(0);
      } finally {
        if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
          fs.unlinkSync(resolved.configPath);
        }
      }
    } finally {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  it("passes cleanly when initWorkspace is run in a workspace and checked (Finding N0)", async () => {
    const tempWorkspace = path.join(os.tmpdir(), `nanos-n0-live-${Date.now()}`);
    fs.mkdirSync(tempWorkspace, { recursive: true });

    try {
      // 1. Initialize workspace (copies .nanos-lint/annotations.lua and writes .luarc.json)
      initWorkspace(tempWorkspace, { force: true });

      // 2. Add valid nanos world code that relies on types from annotations.lua
      const code = `
        local char = Character(Vector(0, 0, 0), Rotator(0, 0, 0), "nanos-world::SK_Mannequin")
        local health = char:GetHealth()
        if health > 0 then
          char:SetHealth(health)
        end
      `;
      fs.writeFileSync(path.join(tempWorkspace, "Server.lua"), code, "utf-8");

      // 3. Resolve and run check on root workspace
      const resolved = resolveWorkspaceConfig(tempWorkspace);
      try {
        const result = await runLuaLSCheck(tempWorkspace, resolved.configPath, {
          path: tempWorkspace,
          checklevel: "Warning",
        });

        // Must not diagnose .nanos-lint/annotations.lua with luadoc warnings
        expect(result.passed).toBe(true);
        expect(result.totalProblems).toBe(0);
      } finally {
        if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
          fs.unlinkSync(resolved.configPath);
        }
      }
    } finally {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  it("reports unused-local at Warning severity through default merged config and recovers from legacy syntax-error (Issue #22)", async () => {
    const rawTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-unused-local-"));
    const tempDir = fs.realpathSync.native ? fs.realpathSync.native(rawTempDir) : fs.realpathSync(rawTempDir);
    try {
      const luaFile = path.join(tempDir, "unused.lua");
      fs.writeFileSync(luaFile, "local myUnused = 123\n", "utf-8");

      // 1. Default merged config (no workspace config)
      const resolved = resolveWorkspaceConfig(tempDir);
      try {
        const result = await runLuaLSCheck(luaFile, resolved.configPath, {
          path: luaFile,
          checklevel: "Warning",
        });
        expect(result.passed).toBe(false);
        expect(result.totalWarnings).toBe(1);
        const diags = Object.values(result.diagnostics).flat();
        const unusedDiag = diags.find((d) => d.code === "unused-local");
        expect(unusedDiag).toBeDefined();
        expect(unusedDiag?.severity).toBe(2); // 2 = Warning
      } finally {
        if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
          fs.unlinkSync(resolved.configPath);
        }
      }

      // 2. Legacy workspace config with obsolete "syntax-error": "Error"
      const legacyConfig = path.join(tempDir, ".luarc.json");
      fs.writeFileSync(
        legacyConfig,
        JSON.stringify({
          diagnostics: {
            severity: {
              "syntax-error": "Error",
              "redefined-local": "Warning",
            },
          },
        }),
        "utf-8"
      );

      const resolvedLegacy = resolveWorkspaceConfig(tempDir);
      try {
        const resultLegacy = await runLuaLSCheck(luaFile, resolvedLegacy.configPath, {
          path: luaFile,
          checklevel: "Warning",
        });
        expect(resultLegacy.passed).toBe(false);
        expect(resultLegacy.totalWarnings).toBe(1);
        const diagsLegacy = Object.values(resultLegacy.diagnostics).flat();
        const unusedDiagLegacy = diagsLegacy.find((d) => d.code === "unused-local");
        expect(unusedDiagLegacy).toBeDefined();
        expect(unusedDiagLegacy?.severity).toBe(2); // 2 = Warning
      } finally {
        if (resolvedLegacy.isTemp && fs.existsSync(resolvedLegacy.configPath)) {
          fs.unlinkSync(resolvedLegacy.configPath);
        }
      }
    } finally {
      fs.rmSync(rawTempDir, { recursive: true, force: true });
      if (tempDir !== rawTempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          void 0;
        }
      }
    }
  });
});

