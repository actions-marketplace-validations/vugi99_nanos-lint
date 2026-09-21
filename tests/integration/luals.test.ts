import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveWorkspaceConfig, getPackageRoot } from "../../src/config.js";
import { runLuaLSCheck, resolveLuaLSBinary } from "../../src/luals.js";

describe("LuaLS live integration tests", () => {
  const root = getPackageRoot();
  const passDir = path.join(root, "tests", "pass");
  const failDir = path.join(root, "tests", "fail");

  beforeAll(async () => {
    // Ensure LuaLS is downloaded and available before running integration tests
    await resolveLuaLSBinary();
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

  it("respects workspace .luarc.json diagnostic overrides", async () => {
    const tempWorkspace = path.join(os.tmpdir(), `nanos-override-test-${Date.now()}`);
    fs.mkdirSync(tempWorkspace, { recursive: true });

    try {
      // Create a test file that would normally trigger undefined-field
      const script = `
        local char = Character(Vector(0,0,0), Rotator(0,0,0), "nanos-world::SK_Mannequin")
        char:SomeNonExistentMethod()
      `;
      fs.writeFileSync(path.join(tempWorkspace, "override_test.lua"), script, "utf-8");

      // Create a workspace .luarc.json disabling undefined-field
      const workspaceConfig = {
        diagnostics: {
          disable: ["undefined-field"],
        },
      };
      fs.writeFileSync(
        path.join(tempWorkspace, ".luarc.json"),
        JSON.stringify(workspaceConfig),
        "utf-8"
      );

      const resolved = resolveWorkspaceConfig(tempWorkspace);
      const result = await runLuaLSCheck(tempWorkspace, resolved.configPath, {
        path: tempWorkspace,
        checklevel: "Warning",
      });

      // undefined-field should be disabled, so totalProblems should be 0
      expect(result.passed).toBe(true);
      expect(result.totalProblems).toBe(0);

      if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
        fs.unlinkSync(resolved.configPath);
      }
    } finally {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });
});

