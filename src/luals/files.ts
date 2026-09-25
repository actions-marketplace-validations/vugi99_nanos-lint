import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { logger } from "../logger.js";
import type { LuaRCConfig } from "../types.js";
import { matchesTargetPaths } from "../target-resolver.js";

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

/** Outcome of normalizing one user-supplied glob pattern. */
interface NormalizedPattern {
  pattern: string | null;
  reason: string | null;
  /** `true` when the rejection is a likely user error worth warning about (#33). */
  actionable: boolean;
}

/**
 * Normalizes a user pattern to slash-separated form, dropping trailing slashes.
 *
 * v3.0.0 (#33) rejects two shapes that used to be silently misread:
 * - absolute patterns, because LuaLS matches patterns relative to the workspace root
 *   and `glob` anchors them inconsistently across platforms;
 * - `!`-prefixed patterns, because LuaLS uses a gitignore-style matcher without
 *   negation support, so honoring negation here would count files LuaLS never checks.
 */
function normalizePattern(pattern: unknown): NormalizedPattern {
  const unusable = (reason: string, actionable = false): NormalizedPattern => ({
    pattern: null,
    reason,
    actionable,
  });
  if (typeof pattern !== "string") {
    return unusable("the value is not a string");
  }
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) {
    return unusable("the value is empty");
  }
  if (normalized === ".") {
    return unusable('"." refers to the workspace root');
  }
  if (normalized.length > MAX_PATTERN_LENGTH) {
    return unusable(`the pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
  }
  if (normalized.includes("\0")) {
    return unusable("the pattern contains a NUL byte");
  }
  if (isAbsolutePattern(normalized)) {
    return unusable("absolute patterns are not supported", true);
  }
  if (normalized.startsWith("!")) {
    return unusable("negation prefixes are not supported by LuaLS", true);
  }
  return { pattern: normalized, reason: null, actionable: false };
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
    const { pattern, reason, actionable } = normalizePattern(raw);
    if (!pattern) {
      const message = `[luals] Skipping glob pattern "${String(raw)}" while counting checked files: ${reason}.`;
      if (actionable) {
        logger.warn(
          `${message} LuaLS never applies it either, so the file count stays consistent.`,
        );
      } else {
        logger.debug(message);
      }
      continue;
    }
    if (!isPatternWithinBudget(pattern)) {
      logger.warn(
        `[luals] Skipping glob pattern "${raw}": it is too complex to match safely and would slow down file counting.`,
      );
      continue;
    }
    ignore.push(...expandIgnorePattern(pattern));
  }
  return ignore;
}

/** Resolves and canonicalizes the target, returning null when it does not exist. */
function resolveTargetPath(targetPath: string): string | null {
  let absPath = path.resolve(targetPath);
  if (!fs.existsSync(absPath)) {
    return null;
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
  return absPath;
}

/**
 * Lists the Lua files LuaLS checks under `targetPath` as slash-normalized relative paths,
 * honoring `workspace.ignoreDir` and `files.exclude` (#27). Absolute paths are returned
 * for single-file targets, and an empty list is returned when the walk fails.
 */
export function listCheckedFiles(
  targetPath: string,
  configPath?: string,
  targetPaths?: string[],
): string[] {
  const absPath = resolveTargetPath(targetPath);
  if (!absPath) {
    return [];
  }

  if (fs.statSync(absPath).isFile()) {
    return absPath.toLowerCase().endsWith(".lua") ? [absPath] : [];
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
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.relativePosix());
    if (targetPaths && targetPaths.length > 0) {
      return files.filter((f) => matchesTargetPaths(f, absPath, targetPaths));
    }
    return files;
  } catch (err) {
    logger.warn(
      `[luals] Failed to walk ${absPath} while listing checked files: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** Counts candidate Lua files within targetPath, taking workspace ignoreDir and files.exclude into account (#27). */
export function countCheckedFiles(
  targetPath: string,
  configPath?: string,
  targetPaths?: string[],
): number {
  return listCheckedFiles(targetPath, configPath, targetPaths).length;
}
