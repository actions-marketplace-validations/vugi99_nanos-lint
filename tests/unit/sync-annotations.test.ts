import { describe, it, expect } from "vitest";
import { sanitizeAnnotations } from "../../scripts/sync-annotations.js";

describe("sync-annotations sanitizer", () => {
  it("patches multiline table default values from Issue #20", () => {
    const raw = `
---Configures the Vehicle Engine
---@param torque_curve? { rpm: number, torque: number } @Map defining the torque (Default: {
	0: 0.0,
	max_rpm * 0.2: 0.9,
	max_rpm * 0.4: 1.0,
	max_rpm * 0.8: 0.8,
	max_rpm: 0.0
})
function VehicleWheeled:SetEngineSetup(torque_curve) end
`;

    const sanitized = sanitizeAnnotations(raw);

    // Assert that the raw code lines are now prefixed with --- comments
    expect(sanitized).toContain("---	0: 0.0,");
    expect(sanitized).toContain("---	max_rpm * 0.2: 0.9,");
    expect(sanitized).toContain("---})");

    // Function definition must remain untouched
    expect(sanitized).toContain("function VehicleWheeled:SetEngineSetup(torque_curve) end");
  });

  it("does not corrupt single-line default table values", () => {
    const raw = `
---@param custom_values? table @An optional table with custom values (Default: {})
function SomeClass:SomeMethod(custom_values) end
`;

    const sanitized = sanitizeAnnotations(raw);
    expect(sanitized).toContain("(Default: {})");
    expect(sanitized).toContain("function SomeClass:SomeMethod(custom_values) end");
  });

  it("fixes vararg any... return types and prepends aliases", () => {
    const raw = `
---@return any... @the function return values
function ExportedFunc() end
`;

    const sanitized = sanitizeAnnotations(raw);
    expect(sanitized).toContain("---@return any @the function return values");
    expect(sanitized).toContain("---@alias bool boolean");
    expect(sanitized).toContain("---@alias iterator any");
  });
});

