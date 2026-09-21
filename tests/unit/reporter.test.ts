import { describe, it, expect } from "vitest";
import {
  formatPretty,
  formatGitHubAnnotations,
  formatSeverityBadge,
  formatReport,
} from "../../src/reporter.js";
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
});
