import { describe, it, expect } from "vitest";
import {
  formatPretty,
  formatGitHubAnnotations,
  formatSeverityBadge,
  formatReport,
  shouldEnableColor,
} from "../../src/reporter.js";
import { fileUriToPath } from "../../src/types.js";
import type { CheckResult } from "../../src/types.js";

describe("reporter module", () => {
  const mockPassingResult: CheckResult = {
    passed: true,
    totalProblems: 0,
    totalFiles: 0,
    diagnostics: {},
  };

  const mockCwd = process.platform === "win32" ? "C:/workspace" : "/workspace";
  const mockFilePath = `${mockCwd}/scripts/test.lua`;
  const mockFileUri = `file:///${mockFilePath.replace(/^[a-zA-Z]:/, (m) => m.toLowerCase())}`;

  const mockFailingResult: CheckResult = {
    passed: false,
    totalProblems: 2,
    totalFiles: 1,
    diagnostics: {
      [mockFileUri]: [
        {
          code: "param-type-mismatch",
          message: "Cannot assign `string` to parameter `number`.",
          range: {
            start: { line: 10, character: 4 },
            end: { line: 10, character: 12 },
          },
          severity: 2,
        },
        {
          code: "syntax-error",
          message: "unexpected symbol near '='",
          range: {
            start: { line: 20, character: 0 },
            end: { line: 20, character: 5 },
          },
          severity: 1,
        },
      ],
    },
  };

  it("formats passing result cleanly", () => {
    const pretty = formatPretty(mockPassingResult);
    expect(pretty).toContain("Diagnosis completed, no problems found");
  });

  it("formats failing result with problem count and diagnostic codes", () => {
    const pretty = formatPretty(mockFailingResult, mockCwd);
    expect(pretty).toContain("param-type-mismatch");
    expect(pretty).toContain("syntax-error");
    expect(pretty).toContain("2 problem(s) found across 1 file(s)");
  });

  it("formats GitHub Actions annotations correctly", () => {
    const annotations = formatGitHubAnnotations(mockFailingResult, mockCwd);
    expect(annotations).toContain(
      "::warning file=scripts/test.lua,line=11,col=5,endLine=11,endColumn=13,title=nanos-lint::Cannot assign `string` to parameter `number`. (param-type-mismatch)"
    );
    expect(annotations).toContain(
      "::error file=scripts/test.lua,line=21,col=1,endLine=21,endColumn=6,title=nanos-lint::unexpected symbol near '=' (syntax-error)"
    );
  });

  it("formats json output when requested", () => {
    const json = formatReport(mockPassingResult, "json");
    const parsed = JSON.parse(json);
    expect(parsed.passed).toBe(true);
    expect(parsed.totalProblems).toBe(0);
  });

  it("formats severity badges properly", () => {
    expect(formatSeverityBadge(1)).toContain("[Error]");
    expect(formatSeverityBadge(2)).toContain("[Warning]");
    expect(formatSeverityBadge(3)).toContain("[Information]");
  });

  it("converts both Unix and Windows file URIs correctly", () => {
    expect(fileUriToPath("file:///home/runner/work/nanos-lint/test.lua")).toBe(
      "/home/runner/work/nanos-lint/test.lua"
    );
    expect(fileUriToPath("file:///C:/Users/alexa/test.lua")).toBe("C:/Users/alexa/test.lua");
    expect(fileUriToPath("file:///c%3A/Users/alexa/test.lua")).toBe("C:/Users/alexa/test.lua");
    expect(fileUriToPath("file://C:/Users/alexa/test.lua")).toBe("C:/Users/alexa/test.lua");
  });

  it("respects NO_COLOR convention and color toggles", () => {
    const origNoColor = process.env.NO_COLOR;
    const origForceColor = process.env.FORCE_COLOR;

    try {
      process.env.NO_COLOR = "1";
      delete process.env.FORCE_COLOR;
      expect(shouldEnableColor()).toBe(false);

      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = "1";
      expect(shouldEnableColor()).toBe(true);
    } finally {
      if (origNoColor !== undefined) {
        process.env.NO_COLOR = origNoColor;
      } else {
        delete process.env.NO_COLOR;
      }
      if (origForceColor !== undefined) {
        process.env.FORCE_COLOR = origForceColor;
      } else {
        delete process.env.FORCE_COLOR;
      }
    }

    // Badge without color
    expect(formatSeverityBadge(1, false)).toBe("[Error]");
    expect(formatSeverityBadge(2, false)).toBe("[Warning]");
    // Badge with color
    expect(formatSeverityBadge(1, true)).toContain("\x1b[31m[Error]\x1b[0m");

    // formatPretty without color should contain no ANSI escapes
    const plainPretty = formatPretty(mockFailingResult, mockCwd, false);
    // eslint-disable-next-line no-control-regex
    expect(plainPretty).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(plainPretty).toContain("2 problem(s) found across 1 file(s)");

    // formatPretty with color should contain ANSI escapes
    const colorPretty = formatPretty(mockFailingResult, mockCwd, true);
    // eslint-disable-next-line no-control-regex
    expect(colorPretty).toMatch(/\x1b\[[0-9;]*m/);
  });
});

