import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateArchiveMembers } from "../../src/luals/validation.js";

describe("archive member validation before extraction", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-pkg-archive-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  function makeZipArchive(options: {
    fileName: string;
    unixMode?: number;
    uncompressedSize?: number;
    entryCount?: number;
  }): Buffer {
    const fn = options.fileName;
    const fnBuf = Buffer.from(fn, "utf-8");
    const uncompressedSize = options.uncompressedSize ?? 10;
    const unixMode = options.unixMode ?? 0o100644; // regular file

    const lh = Buffer.alloc(30 + fnBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // Local file header signature
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(uncompressedSize, 22);
    lh.writeUInt16LE(fnBuf.length, 26);
    fnBuf.copy(lh, 30);

    const ch = Buffer.alloc(46 + fnBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); // Central directory header signature
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(uncompressedSize, 24);
    ch.writeUInt16LE(fnBuf.length, 28);
    ch.writeUInt32LE((unixMode << 16) >>> 0, 38); // external attributes (unix mode in top 16 bits)
    ch.writeUInt32LE(0, 42); // relative offset of local header
    fnBuf.copy(ch, 46);

    const count = options.entryCount ?? 1;
    const eo = Buffer.alloc(22);
    eo.writeUInt32LE(0x06054b50, 0); // End of central directory signature
    eo.writeUInt16LE(count, 8);
    eo.writeUInt16LE(count, 10);
    eo.writeUInt32LE(ch.length, 12);
    eo.writeUInt32LE(lh.length, 16);

    return Buffer.concat([lh, ch, eo]);
  }

  it("accepts a normal zip archive with regular file members", async () => {
    const archivePath = path.join(tmpDir, "valid.zip");
    fs.writeFileSync(archivePath, makeZipArchive({ fileName: "bin/luals.exe" }));

    const res = await validateArchiveMembers(archivePath);
    expect(res.memberCount).toBe(1);
    expect(res.totalDeclaredSize).toBe(10);
  });

  it("rejects zip archive with directory traversal member name", async () => {
    const archivePath = path.join(tmpDir, "traversal.zip");
    fs.writeFileSync(archivePath, makeZipArchive({ fileName: "../escape.exe" }));

    await expect(validateArchiveMembers(archivePath)).rejects.toThrow(
      /Archive member path escapes extraction directory/,
    );
  });

  it("rejects zip archive with absolute member name", async () => {
    const archivePath = path.join(tmpDir, "absolute.zip");
    fs.writeFileSync(archivePath, makeZipArchive({ fileName: "/etc/shadow" }));

    await expect(validateArchiveMembers(archivePath)).rejects.toThrow(
      /Archive member path escapes extraction directory/,
    );
  });

  it("rejects zip archive containing symbolic links", async () => {
    const archivePath = path.join(tmpDir, "symlink.zip");
    fs.writeFileSync(archivePath, makeZipArchive({ fileName: "link-to-bin", unixMode: 0o120000 }));

    await expect(validateArchiveMembers(archivePath)).rejects.toThrow(
      /Archive member is a symbolic or hard link/,
    );
  });

  it("rejects zip archive declaring excessive uncompressed size", async () => {
    const archivePath = path.join(tmpDir, "oversized.zip");
    fs.writeFileSync(
      archivePath,
      makeZipArchive({ fileName: "huge.bin", uncompressedSize: 600 * 1024 * 1024 }),
    );

    await expect(validateArchiveMembers(archivePath)).rejects.toThrow(
      /declared decompressed size.*exceeds maximum limit/,
    );
  });

  it("rejects corrupt zip archive missing EOCD", async () => {
    const archivePath = path.join(tmpDir, "corrupted.zip");
    fs.writeFileSync(archivePath, Buffer.from("PK\x03\x04corrupted-archive-data"));

    await expect(validateArchiveMembers(archivePath)).rejects.toThrow(
      /corrupt or invalid zip archive/,
    );
  });
});
