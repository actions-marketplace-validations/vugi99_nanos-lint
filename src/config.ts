import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { LuaRCConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Finds the package root directory across both development (src/) and production (dist/) environments.
 */
export function getPackageRoot(): string {
  let current = __dirname;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(__dirname, "..");
}

export function getDefinitionsDir(): string {
  const root = getPackageRoot();
  return path.join(root, "vendor", "nanos-world-vscode-extension");
}

export function getDefaultTemplatePath(): string {
  const root = getPackageRoot();
  return path.join(root, "templates", ".luarc.json");
}

/**
 * Strips single-line comments (//), multi-line comments (/* ... *\/),
 * and trailing commas before '}' or ']' from JSONC text while preserving string literals.
 */
export function stripJsonComments(text: string): string {
  const cleanText = text.replace(/^\uFEFF/, "");
  let result = "";
  let i = 0;
  const len = cleanText.length;

  while (i < len) {
    const ch = cleanText[i];

    // String literal: preserve entirely, including escaped characters
    if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        const c = cleanText[i];
        result += c;
        if (c === "\\") {
          i++;
          if (i < len) {
            result += cleanText[i];
          }
        } else if (c === '"') {
          break;
        }
        i++;
      }
      i++;
      continue;
    }

    // Single-line comment: // ...
    if (ch === "/" && i + 1 < len && cleanText[i + 1] === "/") {
      i += 2;
      while (i < len && cleanText[i] !== "\n" && cleanText[i] !== "\r") {
        i++;
      }
      continue;
    }

    // Multi-line comment: /* ... */
    if (ch === "/" && i + 1 < len && cleanText[i + 1] === "*") {
      i += 2;
      while (i + 1 < len && !(cleanText[i] === "*" && cleanText[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    // Trailing comma check before '}' or ']'
    if (ch === ",") {
      let j = i + 1;
      let isTrailing = false;

      while (j < len) {
        const nextChar = cleanText[j];
        if (
          nextChar === " " ||
          nextChar === "\t" ||
          nextChar === "\n" ||
          nextChar === "\r"
        ) {
          j++;
          continue;
        }
        if (nextChar === "/" && j + 1 < len && cleanText[j + 1] === "/") {
          j += 2;
          while (j < len && cleanText[j] !== "\n" && cleanText[j] !== "\r") {
            j++;
          }
          continue;
        }
        if (nextChar === "/" && j + 1 < len && cleanText[j + 1] === "*") {
          j += 2;
          while (j + 1 < len && !(cleanText[j] === "*" && cleanText[j + 1] === "/")) {
            j++;
          }
          j += 2;
          continue;
        }
        if (nextChar === "}" || nextChar === "]") {
          isTrailing = true;
        }
        break;
      }

      if (isTrailing) {
        result += " ";
        i++;
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

export function parseJsonc<T = unknown>(text: string): T {
  const stripped = stripJsonComments(text);
  return JSON.parse(stripped) as T;
}

export function loadConfigFile(filePath: string): LuaRCConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Configuration file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return parseJsonc<LuaRCConfig>(content);
}

export interface MergeConfigOptions {
  cliIgnore?: string[];
}

/**
 * Merges a base nanos configuration with a workspace override configuration.
 * Guarantees that the nanos definitions directory is included in workspace.library,
 * and standardizes paths for LuaLS.
 */
export function mergeConfigs(
  base: LuaRCConfig,
  override: LuaRCConfig = {},
  definitionsDir: string = getDefinitionsDir(),
  options?: MergeConfigOptions
): LuaRCConfig {
  const normalizedDefDir = definitionsDir.split(path.sep).join("/");

  // Merge library paths
  const baseLibraries = base.workspace?.library ?? [];
  const overrideLibraries = override.workspace?.library ?? [];
  const librarySet = new Set<string>([normalizedDefDir, ...baseLibraries, ...overrideLibraries]);

  // Merge globals
  const baseGlobals = base.diagnostics?.globals ?? [];
  const overrideGlobals = override.diagnostics?.globals ?? [];
  const globalsSet = new Set<string>([...baseGlobals, ...overrideGlobals]);

  // Merge severities
  const mergedSeverity = {
    ...(base.diagnostics?.severity ?? {}),
    ...(override.diagnostics?.severity ?? {}),
  };

  const hasCliIgnore = Boolean(options?.cliIgnore && options.cliIgnore.length > 0);

  let mergedIgnoreDir: string[];
  let mergedFilesExclude: string[];

  const baseFilesExclude = base.files?.exclude ?? [];
  const overrideFilesExclude = override.files?.exclude ?? [];

  const defaultIgnore = [
    ".git",
    ".vscode",
    "node_modules",
    "dist",
    "bin",
    "vendor",
    "script",
    "meta",
    "locale",
    "log",
  ];
  const baseIgnore = base.workspace?.ignoreDir ?? defaultIgnore;
  const overrideIgnore = override.workspace?.ignoreDir ?? [];

  if (hasCliIgnore) {
    const normalizedCliIgnore = (options?.cliIgnore ?? [])
      .map((p) => p.replace(/\\/g, "/").trim())
      .filter(Boolean);

    const excludePatterns = new Set<string>([...baseFilesExclude, ...overrideFilesExclude]);
    for (const pat of normalizedCliIgnore) {
      excludePatterns.add(pat);
      if (!pat.includes("*") && !pat.includes("?") && !pat.endsWith(".lua")) {
        const dirPat = pat.replace(/\/+$/, "");
        excludePatterns.add(`${dirPat}/**`);
      }
    }
    mergedFilesExclude = Array.from(excludePatterns);

    // For workspace.ignoreDir, keep default structural exclusions plus any CLI ignore dirs
    const cliDirs = normalizedCliIgnore
      .filter((p) => !p.includes("*") && !p.includes("?") && !p.endsWith(".lua"))
      .map((p) => p.replace(/\/+$/, ""));
    mergedIgnoreDir = Array.from(new Set([...defaultIgnore, ...baseIgnore, ...overrideIgnore, ...cliDirs]));
  } else {
    // Merge ignoreDir using default rules
    mergedIgnoreDir = Array.from(new Set([...defaultIgnore, ...baseIgnore, ...overrideIgnore]));
    mergedFilesExclude = Array.from(new Set([...baseFilesExclude, ...overrideFilesExclude]));
  }

  const merged: LuaRCConfig = {
    $schema: override.$schema ?? base.$schema,
    ...base,
    ...override,
    runtime: {
      version: "Lua 5.4",
      ...(base.runtime ?? {}),
      ...(override.runtime ?? {}),
    },
    workspace: {
      checkThirdParty: false,
      ...(base.workspace ?? {}),
      ...(override.workspace ?? {}),
      library: Array.from(librarySet),
      ignoreDir: mergedIgnoreDir,
    },
    files: {
      ...(base.files ?? {}),
      ...(override.files ?? {}),
      exclude: mergedFilesExclude,
    },
    diagnostics: {
      enable: true,
      ...(base.diagnostics ?? {}),
      ...(override.diagnostics ?? {}),
      globals: Array.from(globalsSet),
      severity: mergedSeverity,
    },
  };

  return merged;
}

export interface ResolveWorkspaceConfigOptions {
  ignore?: string[];
}

/**
 * Discovers any existing workspace configuration and returns the path to an active
 * configuration file with nanos definitions properly injected.
 */
export function resolveWorkspaceConfig(
  workspacePath: string,
  customConfigPath?: string,
  options?: ResolveWorkspaceConfigOptions
): { configPath: string; isTemp: boolean } {
  const defaultTemplate = loadConfigFile(getDefaultTemplatePath());
  const definitionsDir = getDefinitionsDir();

  let userConfig: LuaRCConfig = {};

  if (customConfigPath) {
    userConfig = loadConfigFile(path.resolve(customConfigPath));
  } else {
    const candidate = path.join(workspacePath, ".luarc.json");
    if (fs.existsSync(candidate)) {
      try {
        userConfig = loadConfigFile(candidate);
      } catch (err) {
        throw new Error(
          `Failed to parse workspace configuration file (${candidate}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }
  }

  const hasCliIgnore = Boolean(options?.ignore && options.ignore.length > 0);

  // When relative to workspacePath, expand patterns if they start with workspace prefix
  let cliIgnore = options?.ignore;
  if (hasCliIgnore && cliIgnore) {
    const normWs = workspacePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const expanded: string[] = [];
    for (const pat of cliIgnore) {
      expanded.push(pat);
      const normPat = pat.replace(/\\/g, "/");
      if (normWs && normWs !== "." && normPat.startsWith(`${normWs}/`)) {
        expanded.push(normPat.slice(normWs.length + 1));
      }
    }
    cliIgnore = expanded;
  }

  const merged = mergeConfigs(defaultTemplate, userConfig, definitionsDir, {
    cliIgnore,
  });

  // Only apply hardcoded tool directory exclusions when CLI ignore was NOT provided
  if (!hasCliIgnore) {
    const resolvedTarget = path.resolve(workspacePath);
    const isToolDirectory =
      fs.existsSync(path.join(resolvedTarget, "main.lua")) &&
      (fs.existsSync(path.join(resolvedTarget, "bin", "lua-language-server.exe")) ||
        fs.existsSync(path.join(resolvedTarget, "bin", "lua-language-server")));

    if (isToolDirectory) {
      merged.files = merged.files ?? {};
      const existingExclude = merged.files.exclude ?? [];
      merged.files.exclude = [
        ...new Set([
          ...existingExclude,
          "main.lua",
          "debugger.lua",
          "**/main.lua",
          "**/debugger.lua",
        ]),
      ];
    }
  }

  // Write to a temporary configuration file for LuaLS execution
  const tempDir = path.join(os.tmpdir(), "nanos-lint");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempConfigFile = path.join(tempDir, `luarc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(tempConfigFile, JSON.stringify(merged, null, 2), "utf-8");

  return { configPath: tempConfigFile, isTemp: true };
}

export interface InitWorkspaceOptions {
  force?: boolean;
}

/**
 * Initializes a new .luarc.json in a workspace.
 */
export function initWorkspace(workspacePath: string, options?: InitWorkspaceOptions): string {
  const targetFile = path.join(workspacePath, ".luarc.json");
  if (fs.existsSync(targetFile) && !options?.force) {
    throw new Error(`.luarc.json already exists at ${targetFile}. Use --force to overwrite.`);
  }

  const template = loadConfigFile(getDefaultTemplatePath());
  const definitionsDir = getDefinitionsDir();
  const sourceAnnotations = path.join(definitionsDir, "annotations.lua");

  // Copy annotations to .nanos-lint/annotations.lua inside workspace for portability
  const targetNanosDir = path.join(workspacePath, ".nanos-lint");
  fs.mkdirSync(targetNanosDir, { recursive: true });
  const targetAnnotations = path.join(targetNanosDir, "annotations.lua");
  if (fs.existsSync(sourceAnnotations)) {
    fs.copyFileSync(sourceAnnotations, targetAnnotations);
  }

  template.workspace = template.workspace ?? {};
  template.workspace.library = [".nanos-lint/annotations.lua"];

  fs.writeFileSync(targetFile, JSON.stringify(template, null, 2), "utf-8");
  return targetFile;
}
