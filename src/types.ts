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

