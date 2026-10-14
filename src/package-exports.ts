import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { systemPaths } from "./paths.js";
import type { ResolvedDependencyRealms } from "./deps.js";

/**
 * Dependency packages publish cross-package APIs with `Package.Export("Name", value)`,
 * which binds `value` to the global `Name` for every package on the same side. LuaLS
 * cannot see that binding, so consumers report `undefined-global` for the exported name
 * (#72). This module finds those calls and mirrors each exporting script into a generated
 * library file where the exported names are real globals, so the inferred types — and the
 * `---@param`/`---@return` documentation behind them — survive into consumer packages.
 */

/** A `Package.Export("Name", value)` call found in a package script. */
export interface PackageExportCall {
  /** Decoded export name, as handed to the engine. */
  name: string;
  /** String literal exactly as written, reused verbatim as the capture key. */
  nameLiteral: string;
  /** Source text of the exported value expression. */
  expression: string;
  /** Offset of the `Package` token that starts the call. */
  start: number;
  /** Offset just past the closing parenthesis of the call. */
  end: number;
}

/** Lua reserved words that can never be used as a global variable name. */
const LUA_KEYWORDS: ReadonlySet<string> = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
]);

/** Table collecting exported values inside a generated binding file. */
const CAPTURE_TABLE = "_nanos_lint_exports";
/** Scope wrapper that keeps the original script's file-level locals local. */
const CAPTURE_SCOPE = "_nanos_lint_export_scope";
/** File name prefix of the generated binding files; never collides with a package script. */
const SHADOW_FILE_PREFIX = "nanos-lint-export-";

/** Whether a code unit can start a Lua identifier. */
function isIdentifierStart(code: number | undefined): boolean {
  return (
    code !== undefined && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95)
  );
}

/** Whether a code unit can continue a Lua identifier. */
function isIdentifierPart(code: number | undefined): boolean {
  return isIdentifierStart(code) || (code !== undefined && code >= 48 && code <= 57);
}

/** Returns the number of `=` signs of the long bracket opening at `index`, or null. */
function longBracketLevel(source: string, index: number): number | null {
  if (source[index] !== "[") return null;
  let cursor = index + 1;
  let level = 0;
  while (source[cursor] === "=") {
    level += 1;
    cursor += 1;
  }
  return source[cursor] === "[" ? level : null;
}

/** Returns the offset just past the long bracket opening at `index`, or null when none opens. */
function skipLongBracket(source: string, index: number): number | null {
  const level = longBracketLevel(source, index);
  if (level === null) return null;
  const closer = `]${"=".repeat(level)}]`;
  const closeIndex = source.indexOf(closer, index + level + 2);
  return closeIndex === -1 ? source.length : closeIndex + closer.length;
}

/** Returns the offset just past the short string literal starting at `index`. */
function skipShortString(source: string, index: number): number {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === quote) return cursor + 1;
    if (ch === "\n") return cursor;
    cursor += 1;
  }
  return source.length;
}

/** Returns the offset just past the comment starting at `index` (a `--` sequence). */
function skipComment(source: string, index: number): number {
  const longEnd = skipLongBracket(source, index + 2);
  if (longEnd !== null) return longEnd;
  const lineEnd = source.indexOf("\n", index + 2);
  return lineEnd === -1 ? source.length : lineEnd + 1;
}

/** Returns the offset of the first non-whitespace code unit at or after `index`. */
function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

/** Reads a Lua identifier at `index`, or null when none starts there. */
function readIdentifier(source: string, index: number): string | null {
  if (!isIdentifierStart(source.charCodeAt(index))) return null;
  let cursor = index + 1;
  while (isIdentifierPart(source.charCodeAt(cursor))) {
    cursor += 1;
  }
  return source.slice(index, cursor);
}

/** A parsed string literal plus the offset just past it. */
interface StringLiteral {
  value: string;
  end: number;
}

/** Resolves the escape sequences of a short (quoted) Lua string body. */
function decodeShortString(body: string): string {
  const escapes: Record<string, string> = {
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\u000b",
    "\\": "\\",
    '"': '"',
    "'": "'",
    "\n": "\n",
  };
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index] ?? "";
    if (ch !== "\\") {
      result += ch;
      continue;
    }
    const next = body[index + 1] ?? "";
    if (next === "x") {
      const hex = body.slice(index + 2, index + 4);
      result += /^[0-9a-fA-F]{2}$/.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : "";
      index += 3;
      continue;
    }
    if (next === "z") {
      index += 1;
      while (index + 1 < body.length && /\s/.test(body[index + 1] ?? "")) {
        index += 1;
      }
      continue;
    }
    if (next >= "0" && next <= "9") {
      const digits = body.slice(index + 1).match(/^\d{1,3}/)?.[0] ?? "";
      result += String.fromCharCode(parseInt(digits, 10) % 256);
      index += digits.length;
      continue;
    }
    result += escapes[next] ?? next;
    index += 1;
  }
  return result;
}

/** Reads a Lua string literal (quoted or long bracket) at `index`, or null. */
function readStringLiteral(source: string, index: number): StringLiteral | null {
  const ch = source[index];
  if (ch === '"' || ch === "'") {
    const end = skipShortString(source, index);
    if (end <= index + 1 || source[end - 1] !== ch) return null;
    return { value: decodeShortString(source.slice(index + 1, end - 1)), end };
  }
  const level = longBracketLevel(source, index);
  if (level === null) return null;
  const end = skipLongBracket(source, index);
  if (end === null) return null;
  const body = source.slice(index + level + 2, end - level - 2);
  return { value: body.startsWith("\n") ? body.slice(1) : body, end };
}

/** A whitespace-trimmed argument span inside a call. */
interface ArgumentSpan {
  start: number;
  end: number;
}

/** Result of scanning one call's argument list. */
interface CallArguments {
  args: ArgumentSpan[];
  /** Offset just past the closing parenthesis. */
  end: number;
}

/**
 * Splits the argument list of the call whose `(` sits at `openIndex`, ignoring commas that
 * belong to nested calls, table constructors, strings or comments. Returns null when the
 * parenthesis is never closed.
 */
function readCallArguments(source: string, openIndex: number): CallArguments | null {
  const args: ArgumentSpan[] = [];
  let start = openIndex + 1;
  let depth = 0;
  // Scanning starts inside the call: the opening parenthesis itself is not a nesting level.
  let cursor = openIndex + 1;

  const pushArg = (end: number): void => {
    const trimmedStart = skipWhitespace(source, start);
    let trimmedEnd = end;
    while (trimmedEnd > trimmedStart && /\s/.test(source[trimmedEnd - 1] ?? "")) {
      trimmedEnd -= 1;
    }
    if (trimmedEnd > trimmedStart) {
      args.push({ start: trimmedStart, end: trimmedEnd });
    }
  };

  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "-" && source[cursor + 1] === "-") {
      cursor = skipComment(source, cursor);
      continue;
    }
    if (ch === '"' || ch === "'") {
      cursor = skipShortString(source, cursor);
      continue;
    }
    if (ch === "[") {
      const longEnd = skipLongBracket(source, cursor);
      if (longEnd !== null) {
        cursor = longEnd;
        continue;
      }
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (ch === ")" && depth === 0) {
      pushArg(cursor);
      return { args, end: cursor + 1 };
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (ch === "," && depth === 0) {
      pushArg(cursor);
      start = cursor + 1;
    }
    cursor += 1;
  }
  return null;
}

/** Reads the whole `Package.Export(...)` call starting at the `Package` token. */
function readExportCall(
  source: string,
  start: number,
  afterPackage: number,
): PackageExportCall | null {
  let cursor = skipWhitespace(source, afterPackage);
  if (source[cursor] !== ".") return null;
  cursor = skipWhitespace(source, cursor + 1);
  const member = readIdentifier(source, cursor);
  if (member !== "Export") return null;
  cursor = skipWhitespace(source, cursor + member.length);
  if (source[cursor] !== "(") return null;

  const call = readCallArguments(source, cursor);
  const nameArg = call?.args[0];
  const valueArg = call?.args[1];
  if (!call || !nameArg || !valueArg) return null;

  const literal = readStringLiteral(source, nameArg.start);
  if (!literal || literal.end !== nameArg.end) return null;

  return {
    name: literal.value,
    nameLiteral: source.slice(nameArg.start, nameArg.end),
    expression: source.slice(valueArg.start, valueArg.end),
    start,
    end: call.end,
  };
}

/**
 * Finds every statically analyzable `Package.Export("Name", value)` call in Lua source.
 * Calls with a non-literal name or without a value are skipped: they cannot be mirrored.
 */
export function findPackageExports(source: string): PackageExportCall[] {
  const calls: PackageExportCall[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "-" && source[cursor + 1] === "-") {
      cursor = skipComment(source, cursor);
      continue;
    }
    if (ch === '"' || ch === "'") {
      cursor = skipShortString(source, cursor);
      continue;
    }
    if (ch === "[") {
      const longEnd = skipLongBracket(source, cursor);
      if (longEnd !== null) {
        cursor = longEnd;
        continue;
      }
    }
    if (isIdentifierStart(source.charCodeAt(cursor))) {
      const identifier = readIdentifier(source, cursor) ?? "";
      const previous = source[cursor - 1];
      const isPackageToken =
        identifier === "Package" &&
        !(previous === "." || previous === ":" || isIdentifierPart(source.charCodeAt(cursor - 1)));
      if (isPackageToken) {
        const call = readExportCall(source, cursor, cursor + identifier.length);
        if (call) {
          calls.push(call);
          cursor = call.end;
          continue;
        }
      }
      cursor += identifier.length;
      continue;
    }
    cursor += 1;
  }
  return calls;
}

/** Whether a name can be assigned as a Lua global in generated code. */
export function isBindableGlobalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !LUA_KEYWORDS.has(name);
}

/**
 * Mirrors one exporting script into a library file that declares the exported names as
 * globals. The original statements are wrapped in a function so that file-level locals
 * (which LuaLS would otherwise shadow) stay local, while the exported values are carried
 * out through a capture table and assigned to real globals.
 *
 * Returns null when the script exports no statically bindable global name.
 */
export function buildExportBindingShadow(source: string, sourcePath: string): string | null {
  const calls = findPackageExports(source);
  const bindable: PackageExportCall[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (!isBindableGlobalName(call.name) || seen.has(call.name)) continue;
    seen.add(call.name);
    bindable.push(call);
  }
  if (bindable.length === 0) {
    if (calls.length > 0) {
      logger.debug(
        `[exports] ${sourcePath} declares no statically bindable Package.Export name; skipping.`,
      );
    }
    return null;
  }

  let transformed = source;
  for (const call of [...calls].sort((a, b) => b.start - a.start)) {
    const replacement = `${CAPTURE_TABLE}[${call.nameLiteral}] = ${call.expression}`;
    transformed = transformed.slice(0, call.start) + replacement + transformed.slice(call.end);
  }

  const header = [
    `-- Generated by nanos-lint from ${sourcePath} (#72).`,
    "-- Mirrors Package.Export bindings so consumer packages resolve the exported globals.",
    `local ${CAPTURE_TABLE} = {}`,
    "",
    `local function ${CAPTURE_SCOPE}(...)`,
  ].join("\n");
  const footer = [
    "end",
    "",
    `${CAPTURE_SCOPE}()`,
    "",
    ...bindable.map((call) => `${call.name} = ${CAPTURE_TABLE}[${call.nameLiteral}]`),
    "",
  ].join("\n");

  return `${header}\n${transformed.trimEnd()}\n${footer}`;
}

/** Generated binding libraries for every dependency realm plus the single-pass mode. */
export interface ExportBindingLibraries {
  server: string[];
  client: string[];
  shared: string[];
  all: string[];
  /** Directory holding the generated files, or null when nothing was generated. */
  directory: string | null;
  /** Removes the generated directory; safe to call more than once. */
  cleanup: () => void;
}

/** Realm keys of {@link ResolvedDependencyRealms} that partition generated bindings. */
const REALM_KEYS = ["server", "client", "shared"] as const;

/** Lists the Lua files of a library entry, following directories one level deep at a time. */
function collectLuaFiles(entry: string): string[] {
  const found: string[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(current);
    } catch (err) {
      logger.debug(
        `[exports] Skipping unreadable dependency path ${current}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (stats.isFile()) {
      if (current.toLowerCase().endsWith(".lua")) {
        found.push(current);
      }
      continue;
    }
    if (!stats.isDirectory()) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      logger.debug(
        `[exports] Skipping unreadable dependency directory ${current}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    for (const dirent of entries) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      if (dirent.isDirectory()) {
        pending.push(path.join(current, dirent.name));
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith(".lua")) {
        found.push(path.join(current, dirent.name));
      }
    }
  }
  return found;
}

/**
 * Generates one binding file per dependency script that calls `Package.Export`, and returns
 * the paths partitioned exactly like the dependency libraries they mirror: a binding of a
 * `Server/` script is only visible to server passes, keeping the realm isolation intact.
 */
export function generatePackageExportBindings(
  resolved: ResolvedDependencyRealms,
  options?: { tempRoot?: string },
): ExportBindingLibraries {
  const libraries: ExportBindingLibraries = {
    server: [],
    client: [],
    shared: [],
    all: [],
    directory: null,
    cleanup: () => {},
  };

  const candidates = new Map<string, { content: string; realms: Set<string> }>();
  for (const realm of [...REALM_KEYS, "all"] as const) {
    for (const entry of resolved[realm]) {
      for (const file of collectLuaFiles(entry)) {
        const known = candidates.get(file);
        if (known) {
          if (realm !== "all") known.realms.add(realm);
          continue;
        }
        let content: string;
        try {
          content = fs.readFileSync(file, "utf-8");
        } catch (err) {
          logger.debug(
            `[exports] Cannot read dependency script ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        if (!content.includes("Package.Export")) continue;
        candidates.set(file, {
          content,
          realms: realm === "all" ? new Set<string>() : new Set([realm]),
        });
      }
    }
  }

  if (candidates.size === 0) {
    return libraries;
  }

  const tempRoot = options?.tempRoot ?? systemPaths.temp;
  fs.mkdirSync(tempRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempRoot, SHADOW_FILE_PREFIX));
  libraries.directory = directory;
  libraries.cleanup = () => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (err) {
      logger.debug(
        `[exports] Failed to remove generated bindings at ${directory}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  let index = 0;
  for (const [file, record] of candidates) {
    const shadow = buildExportBindingShadow(record.content, file);
    if (!shadow) continue;
    const target = path.join(directory, `${SHADOW_FILE_PREFIX}${index}.lua`);
    index += 1;
    try {
      fs.writeFileSync(target, shadow, "utf-8");
    } catch (err) {
      logger.warn(
        `[exports] Failed to write export bindings for ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    for (const realm of REALM_KEYS) {
      if (record.realms.has(realm)) {
        libraries[realm].push(target);
      }
    }
    libraries.all.push(target);
  }

  if (libraries.all.length > 0) {
    logger.info(
      `[exports] Mirrored ${libraries.all.length} package script(s) exporting globals with Package.Export.`,
    );
  }
  return libraries;
}
