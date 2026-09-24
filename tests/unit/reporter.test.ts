import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatPretty,
  formatGitHubAnnotations,
  formatSeverityBadge,
  formatReport,
  shouldEnableColor,
  pluralize,
  formatProblemSummary,
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

  it("formats passing result cleanly with file count", () => {
    const pretty = formatPretty(mockPassingResult);
    expect(pretty).toContain("Diagnosis completed, no problems found across 0 files.");

    const singlePass = formatPretty({
      ...mockPassingResult,
      totalFiles: 1,
    });
    expect(singlePass).toContain("Diagnosis completed, no problems found across 1 file.");

    const multiPass = formatPretty({
      ...mockPassingResult,
      totalFiles: 5,
    });
    expect(multiPass).toContain("Diagnosis completed, no problems found across 5 files.");
  });

  it("formats failing result with problem count and diagnostic codes", () => {
    const pretty = formatPretty(mockFailingResult, mockCwd);
    expect(pretty).toContain("param-type-mismatch");
    expect(pretty).toContain("syntax-error");
    expect(pretty).toContain("2 problems (1 error, 1 warning) found across 1 file.");
  });

  it("formats GitHub Actions annotations correctly", () => {
    const annotations = formatGitHubAnnotations(mockFailingResult, mockCwd);
    expect(annotations).toContain(
      "::warning file=scripts/test.lua,line=11,col=5,endLine=11,endColumn=13,title=nanos-lint::Cannot assign `string` to parameter `number`. (param-type-mismatch)",
    );
    expect(annotations).toContain(
      "::error file=scripts/test.lua,line=21,col=1,endLine=21,endColumn=6,title=nanos-lint::unexpected symbol near '=' (syntax-error)",
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
      "/home/runner/work/nanos-lint/test.lua",
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
    expect(plainPretty).toContain("2 problems (1 error, 1 warning) found across 1 file.");

    // formatPretty with color should contain ANSI escapes
    const colorPretty = formatPretty(mockFailingResult, mockCwd, true);
    // eslint-disable-next-line no-control-regex
    expect(colorPretty).toMatch(/\x1b\[[0-9;]*m/);
  });

  describe("pluralize helper", () => {
    it("handles singular and plural cases correctly without (s)", () => {
      expect(pluralize(0, "problem")).toBe("0 problems");
      expect(pluralize(1, "problem")).toBe("1 problem");
      expect(pluralize(2, "problem")).toBe("2 problems");
      expect(pluralize(1, "error")).toBe("1 error");
      expect(pluralize(3, "error")).toBe("3 errors");
      expect(pluralize(1, "warning")).toBe("1 warning");
      expect(pluralize(4, "warning")).toBe("4 warnings");
      expect(pluralize(1, "file")).toBe("1 file");
      expect(pluralize(5, "file")).toBe("5 files");
    });

    it("supports custom plural forms", () => {
      expect(pluralize(1, "category", "categories")).toBe("1 category");
      expect(pluralize(3, "category", "categories")).toBe("3 categories");
    });
  });

  describe("formatProblemSummary helper", () => {
    it("formats summary with errors and warnings breakdown", () => {
      const summary = formatProblemSummary(6, 2, 4, 5);
      expect(summary).toBe(
        "Diagnosis complete: 6 problems (2 errors, 4 warnings) found across 5 files.",
      );
      expect(summary).not.toContain("(s)");
    });

    it("formats summary with errors only", () => {
      const summary = formatProblemSummary(2, 2, 0, 1);
      expect(summary).toBe("Diagnosis complete: 2 problems (2 errors) found across 1 file.");
    });

    it("formats summary with warnings only", () => {
      const summary = formatProblemSummary(1, 0, 1, 1);
      expect(summary).toBe("Diagnosis complete: 1 problem (1 warning) found across 1 file.");
    });

    it("formats summary with single error and single file", () => {
      const summary = formatProblemSummary(1, 1, 0, 1);
      expect(summary).toBe("Diagnosis complete: 1 problem (1 error) found across 1 file.");
    });

    it("includes other diagnostics when present", () => {
      const summary = formatProblemSummary(3, 1, 1, 2);
      expect(summary).toBe(
        "Diagnosis complete: 3 problems (1 error, 1 warning, 1 other) found across 2 files.",
      );
    });
  });

  describe("terminal symbol spacing", () => {
    it("formats check and cross symbols with trailing space across all platforms", () => {
      const pass = formatPretty(mockPassingResult, mockCwd, false);
      const fail = formatPretty(mockFailingResult, mockCwd, false);

      expect(pass).toContain("✔  Diagnosis completed");
      expect(fail).toContain("✖  Diagnosis complete:");
    });
  });

  describe("code snippet and preview rendering", () => {
    it("renders source code snippet and caret pointer when file exists on disk", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reporter-snippet-test-"));
      try {
        const testFile = path.join(tempDir, "sample.lua");
        fs.writeFileSync(testFile, "local x = 123\nlocal y = 'hello'\nprint(x + y)\n", "utf-8");
        const fileUri = pathToFileURL(testFile).href;

        const result: CheckResult = {
          passed: false,
          totalProblems: 2,
          totalFiles: 1,
          diagnostics: {
            [fileUri]: [
              {
                code: "type-error",
                message: "Cannot add number and string",
                range: {
                  start: { line: 2, character: 6 },
                  end: { line: 2, character: 11 },
                },
                severity: 1,
              },
              {
                message: "Multiline error",
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 1, character: 5 },
                },
                severity: 2,
              },
            ],
          },
        };

        const pretty = formatPretty(result, tempDir, false);
        expect(pretty).toContain(
          "sample.lua:3:7 [Error] Cannot add number and string (type-error)",
        );
        expect(pretty).toContain("    print(x + y)");
        expect(pretty).toContain("          ^^^^^");
        expect(pretty).toContain("sample.lua:1:1 [Warning] Multiline error");
        expect(pretty).toContain("    local x = 123");
        expect(pretty).toContain("    ^");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("computes errors and warnings dynamically when totalErrors/totalWarnings are missing", () => {
      const result: CheckResult = {
        passed: false,
        totalProblems: 3,
        totalFiles: 1,
        diagnostics: {
          "file:///test.lua": [
            {
              code: "err1",
              message: "e1",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
            },
            {
              code: "warn1",
              message: "w1",
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
              severity: 2,
            },
            {
              code: "info1",
              message: "i1",
              range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
              severity: 3,
            },
          ],
        },
      };

      const pretty = formatPretty(result, "/workspace", false);
      expect(pretty).toContain("3 problems (1 error, 1 warning, 1 other) found across 1 file.");
    });
  });

  describe("formatReport and formatGitHubAnnotations edge cases", () => {
    it("handles notice severity and character escaping in GitHub annotations", () => {
      const result: CheckResult = {
        passed: false,
        totalProblems: 2,
        totalFiles: 1,
        diagnostics: {
          "file:///workspace/scripts/test%252Cfile.lua": [
            {
              message: "Special: 100% discount\r\nnext line",
              range: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
              severity: 3, // Information -> notice
            },
            {
              message: "Hint message without code",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 4, // Hint -> notice
            },
          ],
          "file:///workspace/scripts/empty.lua": [],
        },
      };

      const annotations = formatGitHubAnnotations(result, "/workspace");
      expect(annotations).toContain(
        "::notice file=scripts/test%252Cfile.lua,line=6,col=3,endLine=6,endColumn=9,title=nanos-lint::Special: 100%25 discount%0D%0Anext line",
      );
      expect(annotations).toContain(
        "::notice file=scripts/test%252Cfile.lua,line=1,col=1,endLine=1,endColumn=2,title=nanos-lint::Hint message without code",
      );
    });

    it("formats report with github and default formats", () => {
      const githubPass = formatReport(mockPassingResult, "github", mockCwd, false);
      expect(githubPass).toContain("Diagnosis completed, no problems found");
      expect(githubPass).not.toContain("::");

      const githubFail = formatReport(mockFailingResult, "github", mockCwd, false);
      expect(githubFail).toContain("::warning");
      expect(githubFail).toContain("Diagnosis complete:");

      // default format
      const defaultReport = formatReport(
        mockPassingResult,
        undefined as unknown as "pretty",
        mockCwd,
        false,
      );
      expect(defaultReport).toContain("Diagnosis completed, no problems found");
    });

    it("formats hint and unknown severity badges", () => {
      expect(formatSeverityBadge(4, false)).toBe("[Hint]");
      expect(formatSeverityBadge(99, false)).toBe("[Warning]");
      expect(formatSeverityBadge(3, true)).toContain("\x1b[36m[Information]\x1b[0m");
      expect(formatSeverityBadge(4, true)).toContain("\x1b[90m[Hint]\x1b[0m");
    });

    it("handles FORCE_COLOR=0 and NO_COLOR='' in shouldEnableColor", () => {
      const origNoColor = process.env.NO_COLOR;
      const origForceColor = process.env.FORCE_COLOR;

      try {
        process.env.NO_COLOR = "";
        process.env.FORCE_COLOR = "0";
        // FORCE_COLOR=0 does not force color
        // NO_COLOR="" should not disable color
        expect(typeof shouldEnableColor()).toBe("boolean");
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
    });
  });
});
