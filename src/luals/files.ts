import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { logger } from "../logger.js";
import type { LuaRCConfig } from "../types.js";

/** Directories skipped unless the workspace config overrides `workspace.ignoreDir`. */
const DEFAULT_IGNORE_DIRS = [".git", ".vscode", ".nanos-lint", "node_modules"];

/** Candidate Lua files: LuaLS checks every `*.lua` file in the tree. */
const LUA_FILE_PATTERN = "**/*.lua";

/** `glob` rejects patterns longer than this, so they are dropped before matching. */
const MAX_PATTERN_LENGTH = 65536;

/**
 * Complexity budget per pattern to bound backtracking and combinatorial brace expansion.
 * Patterns exceeding limits are skipped with a warning to protect against ReDoS (#27).
 */
const MAX_WILDCARDS_PER_SEGMENT = 2;
const MAX_TOTAL_WILDCARDS = 12;
const MAX_BRACE_ALTERNATIVES = 256;

/** Counts wildcard tokens (`*`, `?`, character classes and brace groups). */
function countWildcards(value: string): number {
  let count = 0;
  for (const char of value) {
    if (char === "*" || char === "?" || char === "[" || char === "{") {
      count += 1;
    }
  }
  return count;
}

/**
 * Upper bound of the alternatives brace expansion would produce; `1` when the
 * pattern has no brace groups. Nested groups count towards their parent, which
 * over-estimates on purpose so the bound stays safe.
 */
function estimateBraceAlternatives(pattern: string): number {
  const pending: number[] = [];
  let estimate = 1;
  for (const char of pattern) {
    if (char === "{") {
      pending.push(0);
    } else if (char === "}" && pending.length > 0) {
      const alternatives = (pending.pop() ?? 0) + 1;
      estimate *= alternatives;
      if (pending.length > 0) {
        pending[pending.length - 1] = (pending[pending.length - 1] ?? 0) + alternatives - 1;
      }
    } else if (char === "," && pending.length > 0) {
      pending[pending.length - 1] = (pending[pending.length - 1] ?? 0) + 1;
    }
  }
  return estimate;
}

/** Returns `false` when matching the pattern could become pathologically slow. */
function isPatternWithinBudget(pattern: string): boolean {
  if (estimateBraceAlternatives(pattern) > MAX_BRACE_ALTERNATIVES) {
    return false;
  }
  if (countWildcards(pattern) > MAX_TOTAL_WILDCARDS) {
    return false;
  }
  return pattern
    .split("/")
    .every((segment) => countWildcards(segment) <= MAX_WILDCARDS_PER_SEGMENT);
}

/** Normalizes a user pattern to slash-separated form, dropping trailing slashes and invalid inputs. */
function normalizePattern(pattern: unknown): string | null {
  if (typeof pattern !== "string") {
    return null;
  }
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.length > MAX_PATTERN_LENGTH ||
    normalized.includes("\0") ||
    isAbsolutePattern(normalized)
  ) {
    return null;
  }
  return normalized;
}

/** Drive-letter prefixes, recognized on every platform (not just Windows). */
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:\//;

/** Rejects absolute patterns to maintain cross-platform consistency with LuaLS relative paths. */
function isAbsolutePattern(normalized: string): boolean {
  return path.posix.isAbsolute(normalized) || WINDOWS_ABSOLUTE_PATTERN.test(normalized);
}

/** Expands a LuaLS pattern to include basename and sub-directory variants for glob matching. */
function expandIgnorePattern(pattern: string): string[] {
  return pattern.includes("/") ? [pattern, `${pattern}/**`] : [`**/${pattern}`, `**/${pattern}/**`];
}

/** Normalizes and expands a list of LuaLS patterns into `glob` ignore patterns. */
function toIgnorePatterns(patterns: readonly unknown[]): string[] {
  const ignore: string[] = [];
  for (const raw of patterns) {
    const normalized = normalizePattern(raw);
    if (!normalized) {
      logger.debug(
        `[luals] Skipping unusable glob pattern "${String(raw)}" while counting checked files.`,
      );
      continue;
    }
    if (!isPatternWithinBudget(normalized)) {
      logger.warn(
        `[luals] Skipping glob pattern "${raw}": it is too complex to match safely and would slow down file counting.`,
      );
      continue;
    }
    ignore.push(...expandIgnorePattern(normalized));
  }
  return ignore;
}

/** Counts candidate Lua files within targetPath, taking workspace ignoreDir and files.exclude into account (#27). */
export function countCheckedFiles(targetPath: string, configPath?: string): number {
  let absPath = path.resolve(targetPath);
  if (!fs.existsSync(absPath)) {
    return 0;
  }

  try {
    absPath = fs.realpathSync.native(absPath);
  } catch {
    try {
      absPath = fs.realpathSync(absPath);
    } catch (err) {
      void err;
    }
  }

  if (fs.statSync(absPath).isFile()) {
    return absPath.toLowerCase().endsWith(".lua") ? 1 : 0;
  }

  let ignoreDirs: readonly unknown[] = DEFAULT_IGNORE_DIRS;
  let excludePatterns: readonly unknown[] = [];

  if (configPath && fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as LuaRCConfig;
      // `.luarc.json` is user input, so the declared types are not guaranteed.
      if (Array.isArray(cfg.workspace?.ignoreDir)) {
        ignoreDirs = cfg.workspace.ignoreDir;
      }
      if (Array.isArray(cfg.files?.exclude)) {
        excludePatterns = cfg.files.exclude;
      }
    } catch (err) {
      logger.warn(
        `[luals] Failed to parse config file for file counting at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const ignore = [...toIgnorePatterns(ignoreDirs), ...toIgnorePatterns(excludePatterns)];

  try {
    const entries = globSync(LUA_FILE_PATTERN, {
      cwd: absPath,
      ignore,
      dot: true,
      nocase: true,
      follow: false, // Disallow symlinks to prevent loops and directory escapes (#21)
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isFile()).length;
  } catch (err) {
    logger.warn(
      `[luals] Failed to walk ${absPath} while counting checked files: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
