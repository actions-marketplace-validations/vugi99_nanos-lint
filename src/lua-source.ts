/**
 * Low-level scanner for Lua source text. It answers "what is at this offset and where does it
 * end" for the constructs that hide braces, quotes and keywords from a naive scan — comments,
 * long brackets, short strings and identifiers — without building a syntax tree.
 *
 * Every routine takes and returns absolute offsets into the original source and runs in linear
 * time: dependency scripts are untrusted input, so no regular expression looks for whitespace
 * or repeated tokens (#73 CodeQL report). The callers are `package-exports.ts` (mirroring
 * `Package.Export` bindings) and any future source scan that needs the same tokenization.
 */

/** A parsed string literal plus the offset just past it. */
export interface StringLiteral {
  /** Decoded value, with escape sequences resolved. */
  value: string;
  /** Offset just past the literal. */
  end: number;
}

/**
 * Lua whitespace code units. A lookup keeps whitespace comparisons linear: regular
 * expressions over dependency scripts are both slower and flagged by CodeQL (#73).
 */
const WHITESPACE_CODES: ReadonlySet<number> = new Set([9, 10, 11, 12, 13, 32]);

/** Lua keywords that open a block whose body may contain statement commas. */
export const BLOCK_OPENERS: ReadonlySet<string> = new Set([
  "do",
  "for",
  "function",
  "if",
  "repeat",
  "while",
]);

/** Lua keywords that close a block opened by {@link BLOCK_OPENERS}. */
export const BLOCK_CLOSERS: ReadonlySet<string> = new Set(["end", "until"]);

/** Whether a code unit is Lua whitespace. */
export function isWhitespace(code: number | undefined): boolean {
  return code !== undefined && WHITESPACE_CODES.has(code);
}

/** Whether a code unit can start a Lua identifier. */
export function isIdentifierStart(code: number | undefined): boolean {
  return (
    code !== undefined && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95)
  );
}

/** Whether a code unit is an ASCII decimal digit. */
function isDigit(code: number | undefined): boolean {
  return code !== undefined && code >= 48 && code <= 57;
}

/** Whether a code unit can continue a Lua identifier. */
export function isIdentifierPart(code: number | undefined): boolean {
  return isIdentifierStart(code) || isDigit(code);
}

/** Whether a code unit is an ASCII hexadecimal digit. */
function isHexDigit(code: number | undefined): boolean {
  return (
    isDigit(code) ||
    (code !== undefined && ((code >= 97 && code <= 102) || (code >= 65 && code <= 70)))
  );
}

/** Whether a two-character string is a complete `\x` hexadecimal escape body. */
function isHexPair(text: string): boolean {
  return text.length === 2 && isHexDigit(text.charCodeAt(0)) && isHexDigit(text.charCodeAt(1));
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

/** Returns the offset just past the long bracket closer of `level`, or null when none follows. */
function findLongBracketClose(source: string, index: number, level: number): number | null {
  const closer = `]${"=".repeat(level)}]`;
  const closeIndex = source.indexOf(closer, index + level + 2);
  return closeIndex === -1 ? null : closeIndex + closer.length;
}

/** Returns the offset just past the long bracket opening at `index`, or null when none opens. */
export function skipLongBracket(source: string, index: number): number | null {
  const level = longBracketLevel(source, index);
  if (level === null) return null;
  return findLongBracketClose(source, index, level) ?? source.length;
}

/** Returns the offset just past the short string literal starting at `index`. */
export function skipShortString(source: string, index: number): number {
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
export function skipComment(source: string, index: number): number {
  const longEnd = skipLongBracket(source, index + 2);
  if (longEnd !== null) return longEnd;
  const lineEnd = source.indexOf("\n", index + 2);
  return lineEnd === -1 ? source.length : lineEnd + 1;
}

/** Returns the offset of the first non-whitespace code unit at or after `index`. */
export function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && isWhitespace(source.charCodeAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

/** Reads a Lua identifier at `index`, or null when none starts there. */
export function readIdentifier(source: string, index: number): string | null {
  if (!isIdentifierStart(source.charCodeAt(index))) return null;
  let cursor = index + 1;
  while (isIdentifierPart(source.charCodeAt(cursor))) {
    cursor += 1;
  }
  return source.slice(index, cursor);
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
      result += isHexPair(hex) ? String.fromCharCode(parseInt(hex, 16)) : "";
      index += 3;
      continue;
    }
    if (next === "z") {
      index += 1;
      while (index + 1 < body.length && isWhitespace(body.charCodeAt(index + 1))) {
        index += 1;
      }
      continue;
    }
    if (isDigit(body.charCodeAt(index + 1))) {
      const digits = body.slice(index + 1, index + 4).match(/^\d*/)?.[0] ?? "";
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
export function readStringLiteral(source: string, index: number): StringLiteral | null {
  const ch = source[index];
  if (ch === '"' || ch === "'") {
    const end = skipShortString(source, index);
    if (end <= index + 1 || source[end - 1] !== ch) return null;
    return { value: decodeShortString(source.slice(index + 1, end - 1)), end };
  }
  const level = longBracketLevel(source, index);
  if (level === null) return null;
  const end = findLongBracketClose(source, index, level);
  if (end === null) return null;
  const body = source.slice(index + level + 2, end - level - 2);
  return { value: body.startsWith("\n") ? body.slice(1) : body, end };
}
