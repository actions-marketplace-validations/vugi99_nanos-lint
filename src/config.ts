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
  let result = "";
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    // String literal: preserve entirely, including escaped characters
    if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        const c = text[i];
        result += c;
        if (c === "\\") {
          i++;
          if (i < len) {
            result += text[i];
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
    if (ch === "/" && i + 1 < len && text[i + 1] === "/") {
      i += 2;
      while (i < len && text[i] !== "\n" && text[i] !== "\r") {
        i++;
      }
      continue;
    }

    // Multi-line comment: /* ... */
    if (ch === "/" && i + 1 < len && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < len && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n" || text[i] === "\r") {
          result += text[i];
        } else {
          result += " ";
        }
        i++;
      }
      i += 2; // skip */
      continue;
    }

    // Comma: check if it is a trailing comma before '}' or ']'
    if (ch === ",") {
      let j = i + 1;
      let isTrailing = false;
      while (j < len) {
        const nextChar = text[j];
        if (nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r") {
          j++;
          continue;
        }
        if (nextChar === "/" && j + 1 < len && text[j + 1] === "/") {
          j += 2;
          while (j < len && text[j] !== "\n" && text[j] !== "\r") {
            j++;
          }
          continue;
        }
        if (nextChar === "/" && j + 1 < len && text[j + 1] === "*") {
          j += 2;
          while (j + 1 < len && !(text[j] === "*" && text[j + 1] === "/")) {
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

/**
 * Merges a base nanos configuration with a workspace override configuration.
 * Guarantees that the nanos definitions directory is included in workspace.library,
 * and standardizes paths for LuaLS.
 */
export function mergeConfigs(
  base: LuaRCConfig,
  override: LuaRCConfig = {},
  definitionsDir: string = getDefinitionsDir()
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

/**
 * Discovers any existing workspace configuration and returns the path to an active
 * configuration file with nanos definitions properly injected.
 */
export function resolveWorkspaceConfig(
  workspacePath: string,
  customConfigPath?: string
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
        console.warn(`[config] Warning: Failed to parse workspace .luarc.json: ${err}`);
      }
    }
  }

  const merged = mergeConfigs(defaultTemplate, userConfig, definitionsDir);

  // Write to a temporary configuration file for LuaLS execution
  const tempDir = path.join(os.tmpdir(), "nanos-lint");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempConfigFile = path.join(tempDir, `luarc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(tempConfigFile, JSON.stringify(merged, null, 2), "utf-8");

  return { configPath: tempConfigFile, isTemp: true };
}

/**
 * Initializes a new .luarc.json in a workspace.
 */
export function initWorkspace(workspacePath: string): string {
  const targetFile = path.join(workspacePath, ".luarc.json");
  const template = loadConfigFile(getDefaultTemplatePath());
  const definitionsDir = getDefinitionsDir().split(path.sep).join("/");

  template.workspace = template.workspace ?? {};
  template.workspace.library = [definitionsDir];

  fs.writeFileSync(targetFile, JSON.stringify(template, null, 2), "utf-8");
  return targetFile;
}

