import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { safeExtractArchive, canExtractZip } from "../../scripts/packaging/verify.js";

describe("safeExtractArchive execution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-pkg-safe-extract-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  function createTarGz(
    entries: Array<{ name: string; content?: Buffer; type?: string; linkname?: string }>,
  ): Buffer {
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      const header = Buffer.alloc(512);
      const content = entry.content ?? Buffer.alloc(0);
      header.write(entry.name, 0, 100, "utf-8");
      header.write("0000644\x00", 100, 8, "utf-8");
      header.write("0000000\x000000000\x00", 108, 16, "utf-8");
      header.write(
        content.length.toString(8).padStart(11, "0") + "\x0014000000000\x00        ",
        124,
        32,
        "utf-8",
      );
      header.write(entry.type ?? "0", 156, 1, "utf-8");
      if (entry.linkname) header.write(entry.linkname, 157, 100, "utf-8");
      header.write("ustar\x0000", 257, 8, "utf-8");
      let chksum = 0;
      for (let i = 0; i < 512; i++) chksum += header[i]!;
      header.write(chksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");
      chunks.push(header);
      if (content.length > 0) {
        chunks.push(content);
        const pad = (512 - (content.length % 512)) % 512;
        if (pad > 0) chunks.push(Buffer.alloc(pad));
      }
    }
    chunks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(chunks));
  }

  function createValidZip(fileName: string, content: Buffer): Buffer {
    const fnBuf = Buffer.from(fileName, "utf-8");
    const lh = Buffer.alloc(30 + fnBuf.length + content.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(content.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(fnBuf.length, 26);
    fnBuf.copy(lh, 30);
    content.copy(lh, 30 + fnBuf.length);

    const ch = Buffer.alloc(46 + fnBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(content.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(fnBuf.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(0, 42);
    fnBuf.copy(ch, 46);

    const eo = Buffer.alloc(22);
    eo.writeUInt32LE(0x06054b50, 0);
    eo.writeUInt16LE(1, 8);
    eo.writeUInt16LE(1, 10);
    eo.writeUInt32LE(ch.length, 12);
    eo.writeUInt32LE(lh.length, 16);

    return Buffer.concat([lh, ch, eo]);
  }

  it("extracts a valid tar.gz archive and cleans existing target directory", async () => {
    const archivePath = path.join(tmpDir, "sample.tar.gz");
    const targetDir = path.join(tmpDir, "extracted-tar");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "stale.txt"), "old content");

    const payload = Buffer.from("hello nanos world");
    fs.writeFileSync(archivePath, createTarGz([{ name: "hello.txt", content: payload }]));

    await safeExtractArchive(archivePath, targetDir);

    expect(fs.existsSync(path.join(targetDir, "stale.txt"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "hello.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, "hello.txt"))).toEqual(payload);
  });

  it.skipIf(!canExtractZip())("extracts a valid zip archive cleanly", async () => {
    const archivePath = path.join(tmpDir, "sample.zip");
    const targetDir = path.join(tmpDir, "extracted-zip");
    const payload = Buffer.from("zip member content");

    fs.writeFileSync(archivePath, createValidZip("entry.txt", payload));

    await safeExtractArchive(archivePath, targetDir);

    expect(fs.existsSync(path.join(targetDir, "entry.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, "entry.txt"))).toEqual(payload);
  });

  it("rejects a tar.gz archive containing traversal paths before extracting", async () => {
    const archivePath = path.join(tmpDir, "traversal.tar.gz");
    const targetDir = path.join(tmpDir, "extracted-traversal");

    fs.writeFileSync(
      archivePath,
      createTarGz([{ name: "../escape.sh", content: Buffer.from("echo hi") }]),
    );

    await expect(safeExtractArchive(archivePath, targetDir)).rejects.toThrow(
      /Archive member path escapes extraction directory/,
    );
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it("rejects a tar.gz archive containing symlinks before extracting", async () => {
    const archivePath = path.join(tmpDir, "symlink.tar.gz");
    const targetDir = path.join(tmpDir, "extracted-symlink");

    fs.writeFileSync(
      archivePath,
      createTarGz([
        { name: "original.txt", content: Buffer.from("orig") },
        { name: "link.txt", type: "2", linkname: "original.txt" },
      ]),
    );

    await expect(safeExtractArchive(archivePath, targetDir)).rejects.toThrow(
      /symbolic or hard link/,
    );
    expect(fs.existsSync(targetDir)).toBe(false);
  });
});
