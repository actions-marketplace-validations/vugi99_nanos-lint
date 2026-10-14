import { describe, expect, it } from "vitest";
import {
  BLOCK_CLOSERS,
  BLOCK_OPENERS,
  isIdentifierPart,
  isIdentifierStart,
  isWhitespace,
  readIdentifier,
  readStringLiteral,
  skipComment,
  skipLongBracket,
  skipShortString,
  skipWhitespace,
} from "../../src/lua-source.js";

const LUA_WHITESPACE = " \t\r\n\u000b\u000c";

describe("Lua source scanner (#73)", () => {
  it("classifies whitespace, identifiers and identifier continuations", () => {
    for (const ch of LUA_WHITESPACE) {
      expect(isWhitespace(ch.charCodeAt(0))).toBe(true);
    }
    expect(isWhitespace("a".charCodeAt(0))).toBe(false);
    expect(isWhitespace(undefined)).toBe(false);

    expect(isIdentifierStart("a".charCodeAt(0))).toBe(true);
    expect(isIdentifierStart("_".charCodeAt(0))).toBe(true);
    expect(isIdentifierStart("Z".charCodeAt(0))).toBe(true);
    expect(isIdentifierStart("1".charCodeAt(0))).toBe(false);
    expect(isIdentifierStart(undefined)).toBe(false);

    expect(isIdentifierPart("9".charCodeAt(0))).toBe(true);
    expect(isIdentifierPart("a".charCodeAt(0))).toBe(true);
    expect(isIdentifierPart(".".charCodeAt(0))).toBe(false);
  });

  it("keeps block keywords apart from ordinary keywords", () => {
    expect([...BLOCK_OPENERS].sort()).toEqual(["do", "for", "function", "if", "repeat", "while"]);
    expect([...BLOCK_CLOSERS].sort()).toEqual(["end", "until"]);
    for (const keyword of BLOCK_OPENERS) {
      expect(BLOCK_CLOSERS.has(keyword)).toBe(false);
    }
  });

  it("reads identifiers and skips whitespace", () => {
    const source = "\n\t value_1 = 2";

    expect(readIdentifier(source, skipWhitespace(source, 0))).toBe("value_1");
    expect(readIdentifier(source, 0)).toBeNull();
    expect(skipWhitespace(source, 0)).toBe(3);
  });

  it("skips short strings, line comments and long comments", () => {
    const source = 'local s = "a\\"b" -- tail\n[[ignored]]';

    expect(skipShortString(source, 10)).toBe(16);
    expect(skipComment(source, 16)).toBe(25);
    expect(skipComment("--[[ multi\nline ]]\nrest", 0)).toBe(18);
    expect(skipComment("-- no newline", 0)).toBe(13);
  });

  it("skips long brackets of every level, falling back to the end of the source", () => {
    const source = "[==[ body ]==] tail";

    expect(skipLongBracket(source, 0)).toBe(14);
    expect(skipLongBracket("[[unterminated", 0)).toBe(14);
    expect(skipLongBracket("plain", 0)).toBeNull();
  });

  it("terminates a short string at a raw newline", () => {
    expect(skipShortString('"unterminated\nnext', 0)).toBe(13);
    expect(skipShortString('"to the end', 0)).toBe(11);
  });

  it("reads quoted literals with their escape sequences resolved", () => {
    const cases: [string, string][] = [
      ['"plain"', "plain"],
      ["'single'", "single"],
      ['"tab\\tnewline\\n"', "tab\tnewline\n"],
      ['"\\65\\066"', "AB"],
      ['"\\255\\256"', String.fromCharCode(255, 0)],
      ['"\\x41\\x4a"', "AJ"],
      ['"\\xZZ"', ""],
      ['"\\z   joined"', "joined"],
      ['"\\q\\"quoted\\""', 'q"quoted"'],
      ['"line\\\ncontinued"', "line\ncontinued"],
    ];
    for (const [literal, value] of cases) {
      expect(readStringLiteral(literal, 0)).toEqual({ value, end: literal.length });
    }
  });

  it("reads long-bracket literals and strips one leading newline", () => {
    const literal = "[[\nbody]]";
    expect(readStringLiteral(literal, 0)).toEqual({ value: "body", end: literal.length });
    expect(readStringLiteral("[==[raw]==]", 0)).toEqual({ value: "raw", end: 11 });
  });

  it("returns null for unterminated or non-literal input", () => {
    expect(readStringLiteral('"open', 0)).toBeNull();
    expect(readStringLiteral("plain", 0)).toBeNull();
    expect(readStringLiteral("[[open", 0)).toBeNull();
    // A bracket-like prefix that never opens a long bracket.
    expect(readStringLiteral("[=[", 0)).toBeNull();
  });
});
