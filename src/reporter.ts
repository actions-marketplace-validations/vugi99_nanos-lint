import fs from "node:fs";
import path from "node:path";
import type { CheckResult, DiagnosticSeverity } from "./types.js";

const SEVERITY_NAMES: Record<number, DiagnosticSeverity> = {
  1: "Error",
  2: "Warning",
  3: "Information",
  4: "Hint",
};

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export function formatSeverityBadge(severity: number): string {
  const name = SEVERITY_NAMES[severity] || "Warning";
  switch (severity) {
    case 1:
      return `${colors.red}[${name}]${colors.reset}`;
    case 2:
      return `${colors.yellow}[${name}]${colors.reset}`;
    case 3:
      return `${colors.cyan}[${name}]${colors.reset}`;
    default:
      return `${colors.gray}[${name}]${colors.reset}`;
  }
}

export function formatPretty(result: CheckResult, cwd: string = process.cwd()): string {
  if (result.passed) {
    return `${colors.green}${colors.bold}✔ Diagnosis completed, no problems found.${colors.reset}`;
  }

  const lines: string[] = [];

  for (const [rawUri, diags] of Object.entries(result.diagnostics)) {
    if (!diags || diags.length === 0) continue;

    // Convert file:// or absolute path to relative if within cwd
    let filePath = rawUri.startsWith("file://")
      ? decodeURIComponent(rawUri.replace(/^file:\/\/\/?/, ""))
      : rawUri;

    // On Windows, fix /C:/ to C:/
    filePath = filePath.replace(/^\/([a-zA-Z]:)/, "$1");

    // On Windows, fix drive letter lowercase c:/ to C:/
    if (/^[a-zA-Z]:\//.test(filePath)) {
      filePath = filePath.charAt(0).toUpperCase() + filePath.slice(1);
    }

    const relPath = path.isAbsolute(filePath)
      ? path.relative(cwd, filePath) || filePath
      : filePath;

    let fileContent: string[] = [];
    try {
      if (fs.existsSync(filePath)) {
        fileContent = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
      }
    } catch {
      // Ignore read error
    }

    for (const d of diags) {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const badge = formatSeverityBadge(d.severity);
      const code = d.code ? `${colors.magenta}(${d.code})${colors.reset}` : "";

      lines.push(
        `${colors.blue}${relPath}:${line}:${col}${colors.reset} ${badge} ${d.message} ${code}`
      );

      // Line snippet preview
      if (fileContent.length >= line) {
        const sourceLine = fileContent[line - 1];
        const indent = "    ";
        lines.push(`${indent}${sourceLine}`);

        const caretOffset = Math.max(0, d.range.start.character);
        const caretLength =
          d.range.start.line === d.range.end.line
            ? Math.max(1, d.range.end.character - d.range.start.character)
            : 1;

        const pointer = " ".repeat(caretOffset) + "^".repeat(caretLength);
        lines.push(`${indent}${colors.gray}${pointer}${colors.reset}`);
      }
    }
  }

  lines.push("");
  lines.push(
    `${colors.red}${colors.bold}✖ Diagnosis complete: ${result.totalProblems} problem(s) found across ${result.totalFiles} file(s).${colors.reset}`
  );

  return lines.join("\n");
}

export function formatGitHubAnnotations(result: CheckResult, cwd: string = process.cwd()): string {
  const commands: string[] = [];

  for (const [rawUri, diags] of Object.entries(result.diagnostics)) {
    if (!diags || diags.length === 0) continue;

    let filePath = rawUri.startsWith("file://")
      ? decodeURIComponent(rawUri.replace(/^file:\/\/\/?/, ""))
      : rawUri;

    filePath = filePath.replace(/^\/([a-zA-Z]:)/, "$1");

    if (/^[a-zA-Z]:\//.test(filePath)) {
      filePath = filePath.charAt(0).toUpperCase() + filePath.slice(1);
    }

    const relPath = path.isAbsolute(filePath)
      ? path.relative(cwd, filePath).replace(/\\/g, "/")
      : filePath.replace(/\\/g, "/");

    for (const d of diags) {
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const endLine = d.range.end.line + 1;
      const endCol = d.range.end.character + 1;

      const level = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "notice";
      const codeSuffix = d.code ? ` (${d.code})` : "";
      const escapedMessage = d.message
        .replace(/%/g, "%25")
        .replace(/\r/g, "%0D")
        .replace(/\n/g, "%0A");

      commands.push(
        `::${level} file=${relPath},line=${line},col=${col},endLine=${endLine},endColumn=${endCol},title=nanos-lint::${escapedMessage}${codeSuffix}`
      );
    }
  }

  return commands.join("\n");
}

export function formatReport(
  result: CheckResult,
  format: "pretty" | "json" | "github" = "pretty",
  cwd: string = process.cwd()
): string {
  switch (format) {
    case "json":
      return JSON.stringify(result, null, 2);
    case "github": {
      const pretty = formatPretty(result, cwd);
      const annotations = formatGitHubAnnotations(result, cwd);
      return annotations ? `${annotations}\n\n${pretty}` : pretty;
    }
    case "pretty":
    default:
      return formatPretty(result, cwd);
  }
}
