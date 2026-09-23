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
 * Complexity budget per pattern. `minimatch` evaluates patterns through an AST
 * but still compiles them to regular expressions, so ambiguous wildcards inside
 * one path segment can backtrack, and brace groups expand combinatorially
 * (`{a,b}` repeated 16 times is 65 536 alternatives). A hostile or accidental
 * `.luarc.json` could otherwise stall the file walk, so patterns beyond the
 * budget are skipped with a warning instead of being matched.
 *
 * The ambiguity of one segment grows like `C(segment length, wildcards)`, so the
 * per-segment cap is what keeps matching cheap. `**\/*a*a*a*a\/*a*a*a*a\/*a*a*a*a\/*a*a*a*z.lua`
 * (4 wildcards per segment) stays within a 4-wildcard cap yet costs ~5 ms per
 * candidate file — ~100 s on a 20 000-file tree — while two wildcards per
 * segment cost `C(60, 2) = 1 770` splits, hundreds of times less. The budget is
 * deliberately far below what minimatch can parse: every realistic pattern
 * (`**\/*.{bak,tmp}`, `**\/node_modules\/**`, `**\/item-[0-9].lua`,
 * `**\/*.min.*`) needs at most two wildcards in any one segment.
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

/**
 * Normalizes one user-supplied pattern (`workspace.ignoreDir`, `files.exclude`
 * or a built-in default) into the slash-separated form `glob` expects.
 * Backslashes are accepted as separators so Windows-authored `.luarc.json`
 * files keep working, and trailing slashes are dropped so `vendor/` behaves
 * exactly like `vendor`. Patterns that cannot be matched (`""`, `"."`, NUL
 * bytes, oversized input, or non-string JSON values) are rejected instead of
 * being handed to `glob`.
 */
function normalizePattern(pattern: unknown): string | null {
  if (typeof pattern !== "string") {
    return null;
  }
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.length > MAX_PATTERN_LENGTH ||
    normalized.includes("\0")
  ) {
    return null;
  }
  return normalized;
}

/**
 * Expands one LuaLS pattern into the equivalent `glob` ignore patterns:
 *
 * - basename-only patterns (`*.lua`, `vendor`) match at any depth, so the
 *   `**\/`-prefixed variants are added (mirrors LuaLS `matchBase` semantics);
 * - a pattern also excludes everything below a matching directory, which is
 *   what the trailing `/**` variant expresses;
 * - the pattern itself is always kept so an exact file or directory match
 *   works as written.
 */
function expandIgnorePattern(pattern: string): string[] {
  return pattern.includes("/")
    ? [pattern, `${pattern}/**`]
    : [`**/${pattern}`, `**/${pattern}/**`];
}

/** Normalizes and expands a list of LuaLS patterns into `glob` ignore patterns. */
function toIgnorePatterns(patterns: readonly unknown[]): string[] {
  const ignore: string[] = [];
  for (const raw of patterns) {
    const normalized = normalizePattern(raw);
    if (!normalized) {
      logger.debug(
        `[luals] Skipping unusable glob pattern "${String(raw)}" while counting checked files.`
      );
      continue;
    }
    if (!isPatternWithinBudget(normalized)) {
      logger.warn(
        `[luals] Skipping glob pattern "${raw}": it is too complex to match safely and would slow down file counting.`
      );
      continue;
    }
    ignore.push(...expandIgnorePattern(normalized));
  }
  return ignore;
}

/**
 * Counts candidate Lua files within targetPath, taking `workspace.ignoreDir`
 * and `files.exclude` into account.
 *
 * Traversal and matching are delegated to the bundled `glob` package, whose
 * `minimatch` matcher understands the full glob syntax LuaLS accepts (brace
 * expansion, character classes, `**`, `?`) instead of the hand-rolled
 * glob-to-regex translation used before. Combined with the pattern budgets
 * above, this keeps the count predictable for adversarial configurations
 * while remaining consistent with LuaLS exclude semantics (#27).
 */
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
        `[luals] Failed to parse config file for file counting at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const ignore = [
    ...toIgnorePatterns(ignoreDirs),
    ...toIgnorePatterns(excludePatterns),
  ];

  try {
    const entries = globSync(LUA_FILE_PATTERN, {
      cwd: absPath,
      ignore,
      // LuaLS counts dotfiles, and nanos-lint matching stays case-insensitive
      // on every platform so the reported totals do not vary by filesystem.
      dot: true,
      nocase: true,
      // Symlinked directories are never traversed: this prevents both symlink
      // loops and escaping the checked tree (#21).
      follow: false,
      withFileTypes: true,
    });
    // Symbolic links are not followed, so they are not counted either (#21).
    return entries.filter((entry) => entry.isFile()).length;
  } catch (err) {
    logger.warn(
      `[luals] Failed to walk ${absPath} while counting checked files: ${err instanceof Error ? err.message : String(err)}`
    );
    return 0;
  }
}
