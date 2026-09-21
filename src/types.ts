export type DiagnosticSeverity = "Error" | "Warning" | "Information" | "Hint";

export interface DiagnosticRange {
  start: {
    line: number;
    character: number;
  };
  end: {
    line: number;
    character: number;
  };
}

export interface Diagnostic {
  range: DiagnosticRange;
  severity: number; // 1 = Error, 2 = Warning, 3 = Information, 4 = Hint
  code?: string;
  message: string;
  source?: string;
}

export type DiagnosticReport = Record<string, Diagnostic[]>;

export interface CheckOptions {
  path: string;
  checklevel?: DiagnosticSeverity;
  configpath?: string;
  lualsVersion?: string;
  format?: "pretty" | "json" | "github";
  failOnError?: boolean;
  quiet?: boolean;
  lualsBin?: string;
}

export interface CheckResult {
  passed: boolean;
  totalProblems: number;
  totalFiles: number;
  diagnostics: DiagnosticReport;
  outputPath?: string;
}

export interface LuaRCConfig {
  $schema?: string;
  runtime?: {
    version?: string;
    path?: string[];
    [key: string]: unknown;
  };
  workspace?: {
    checkThirdParty?: boolean;
    library?: string[];
    ignoreDir?: string[];
    [key: string]: unknown;
  };
  diagnostics?: {
    enable?: boolean;
    globals?: string[];
    disable?: string[];
    severity?: Record<string, string>;
    neededFileStatus?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Converts a URI (e.g. `file:///path/to/file` or `file:///C:/path/to/file` or `file:///c%3A/path`)
 * to a standard local file system path across both Windows and Unix.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }

  let decoded = decodeURIComponent(uri.slice(7));

  // Windows file URIs often look like /C:/foo or /c:/foo
  if (/^\/[a-zA-Z]:/.test(decoded)) {
    decoded = decoded.slice(1);
  }

  // Normalize drive letter to uppercase on Windows
  if (/^[a-zA-Z]:/.test(decoded)) {
    return decoded.charAt(0).toUpperCase() + decoded.slice(1);
  }

  // Unix file URIs look like /home/runner/file.lua
  return decoded;
}


