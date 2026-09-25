import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { verifyExtractedTreeInvariants } from "../../scripts/packaging/verify.js";

describe("extracted tree invariant checks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-pkg-tree-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  function setupValidTree(arch: "x64" | "arm64" = "x64"): {
    binName: string;
    binPath: string;
  } {
    const binName = "lua-language-server";
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const binPath = path.join(binDir, binName);
    const elfBuf = Buffer.alloc(120_000);
    elfBuf.writeUInt32BE(0x7f454c46, 0); // ELF magic
    elfBuf.writeUInt16LE(arch === "x64" ? 0x3e : 0xb7, 18);
    fs.writeFileSync(binPath, elfBuf);

    fs.writeFileSync(path.join(tmpDir, "main.lua"), "-- main script\n");
    return { binName, binPath };
  }

  it("accepts a well-formed extracted directory tree", () => {
    const { binName } = setupValidTree("x64");
    const result = verifyExtractedTreeInvariants(tmpDir, {
      expectedBinName: binName,
      expectedArch: "x64",
    });

    expect(result.fileCount).toBeGreaterThanOrEqual(2);
    expect(result.totalBytes).toBeGreaterThanOrEqual(120_000);
  });

  it("fails if destination directory does not exist", () => {
    const nonExistent = path.join(tmpDir, "does-not-exist");
    expect(() =>
      verifyExtractedTreeInvariants(nonExistent, {
        expectedBinName: "lua-language-server",
        expectedArch: "x64",
      }),
    ).toThrow(/not an existing directory/);
  });

  it("fails if main.lua is missing", () => {
    const { binName } = setupValidTree("x64");
    fs.unlinkSync(path.join(tmpDir, "main.lua"));

    expect(() =>
      verifyExtractedTreeInvariants(tmpDir, {
        expectedBinName: binName,
        expectedArch: "x64",
      }),
    ).toThrow(/missing main\.lua/);
  });

  it("fails if expected binary is missing", () => {
    setupValidTree("x64");
    expect(() =>
      verifyExtractedTreeInvariants(tmpDir, {
        expectedBinName: "other-binary",
        expectedArch: "x64",
      }),
    ).toThrow(/missing expected binary/);
  });

  it("fails if binary is smaller than minimum threshold", () => {
    const { binName, binPath } = setupValidTree("x64");
    const smallBuf = Buffer.alloc(500);
    smallBuf.writeUInt32BE(0x7f454c46, 0);
    smallBuf.writeUInt16LE(0x3e, 18);
    fs.writeFileSync(binPath, smallBuf);

    expect(() =>
      verifyExtractedTreeInvariants(tmpDir, {
        expectedBinName: binName,
        expectedArch: "x64",
      }),
    ).toThrow(/suspiciously small/);
  });

  it("fails if binary architecture mismatches target", () => {
    const { binName } = setupValidTree("arm64");
    expect(() =>
      verifyExtractedTreeInvariants(tmpDir, {
        expectedBinName: binName,
        expectedArch: "x64",
      }),
    ).toThrow(/Binary architecture mismatch/);
  });

  it("fails if total size exceeds configured maximum limit", () => {
    const { binName } = setupValidTree("x64");
    expect(() =>
      verifyExtractedTreeInvariants(tmpDir, {
        expectedBinName: binName,
        expectedArch: "x64",
        maxTotalBytes: 50_000,
      }),
    ).toThrow(/total size.*exceeds limit/);
  });

  it("detects and rejects hard links in the tree", () => {
    const { binName } = setupValidTree("x64");
    const sourceFile = path.join(tmpDir, "source.txt");
    const hardLink = path.join(tmpDir, "hardlink.txt");
    fs.writeFileSync(sourceFile, "data");

    try {
      fs.linkSync(sourceFile, hardLink);
    } catch (err) {
      void err;
      return;
    }

    expect(() =>
      verifyExtractedTreeInvariants(tmpDir, {
        expectedBinName: binName,
        expectedArch: "x64",
      }),
    ).toThrow(/hard link detected/);
  });

  it("detects and rejects symbolic links in the tree", () => {
    const { binName } = setupValidTree("x64");
    const targetFile = path.join(tmpDir, "target.txt");
    const symlinkPath = path.join(tmpDir, "symlink.txt");
    fs.writeFileSync(targetFile, "data");

    try {
      fs.symlinkSync("target.txt", symlinkPath);
    } catch (err) {
      void err;
      return;
    }

    expect(() =>
      verifyExtractedTreeInvariants(tmpDir, {
        expectedBinName: binName,
        expectedArch: "x64",
      }),
    ).toThrow(/symbolic link detected/);
  });
});
