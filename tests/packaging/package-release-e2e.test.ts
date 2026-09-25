import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { crc32, gzipSync } from "node:zlib";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { packageRelease } from "../../scripts/package-release.js";
import { canExtractZip } from "../../scripts/packaging/verify.js";
import { canCreateZip } from "../../scripts/packaging/bundle.js";

describe("packageRelease end-to-end smoke test", () => {
  let tmpRepo: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-pkg-e2e-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  function createElfHeader(): Buffer {
    const buf = Buffer.alloc(120_000);
    buf.writeUInt32BE(0x7f454c46, 0); // \x7fELF
    buf.writeUInt8(2, 4); // 64-bit
    buf.writeUInt8(1, 5); // little endian
    buf.writeUInt16LE(0x3e, 18); // x86-64 machine
    return buf;
  }

  function createValidLualsTarGz(): Buffer {
    const entries: Array<{ name: string; content: Buffer }> = [
      { name: "bin/lua-language-server", content: createElfHeader() },
      { name: "main.lua", content: Buffer.from("-- luals main\n") },
      { name: "locale/en-us.lua", content: Buffer.from("return {}\n") },
      { name: "meta/base.lua", content: Buffer.from("return {}\n") },
      { name: "script/core.lua", content: Buffer.from("return {}\n") },
    ];
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      const header = Buffer.alloc(512);
      const content = entry.content;
      header.write(entry.name, 0, 100, "utf-8");
      header.write("0000755\x00", 100, 8, "utf-8");
      header.write("0000000\x000000000\x00", 108, 16, "utf-8");
      header.write(
        content.length.toString(8).padStart(11, "0") + "\x0014000000000\x00        ",
        124,
        32,
        "utf-8",
      );
      header.write("0", 156, 1, "utf-8");
      header.write("ustar\x0000", 257, 8, "utf-8");
      let chksum = 0;
      for (let i = 0; i < 512; i++) chksum += header[i]!;
      header.write(chksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");
      chunks.push(header);
      chunks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
    chunks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(chunks));
  }

  function createPeHeader(): Buffer {
    const buf = Buffer.alloc(120_000);
    buf.write("MZ", 0, "ascii");
    buf.writeUInt32LE(0x80, 0x3c);
    buf.write("PE\u0000\u0000", 0x80, "ascii");
    buf.writeUInt16LE(0x8664, 0x84); // x64 PE
    return buf;
  }

  function createValidLualsZip(): Buffer {
    const entries: Array<{ name: string; content: Buffer }> = [
      { name: "bin/lua-language-server.exe", content: createPeHeader() },
      { name: "main.lua", content: Buffer.from("-- luals main\n") },
      { name: "locale/en-us.lua", content: Buffer.from("return {}\n") },
      { name: "meta/base.lua", content: Buffer.from("return {}\n") },
      { name: "script/core.lua", content: Buffer.from("return {}\n") },
    ];

    const localChunks: Buffer[] = [];
    const cdChunks: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
      const fn = Buffer.from(entry.name, "utf-8");
      const data = entry.content;
      const crc = crc32(data);

      const lh = Buffer.alloc(30 + fn.length + data.length);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(data.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(fn.length, 26);
      fn.copy(lh, 30);
      data.copy(lh, 30 + fn.length);
      localChunks.push(lh);

      const ch = Buffer.alloc(46 + fn.length);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(data.length, 20);
      ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(fn.length, 28);
      ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      ch.writeUInt32LE(offset, 42);
      fn.copy(ch, 46);
      cdChunks.push(ch);

      offset += lh.length;
    }

    const cdTotalSize = cdChunks.reduce((acc, c) => acc + c.length, 0);
    const eo = Buffer.alloc(22);
    eo.writeUInt32LE(0x06054b50, 0);
    eo.writeUInt16LE(entries.length, 8);
    eo.writeUInt16LE(entries.length, 10);
    eo.writeUInt32LE(cdTotalSize, 12);
    eo.writeUInt32LE(offset, 16);

    return Buffer.concat([...localChunks, ...cdChunks, eo]);
  }

  function setupRepoFiles(repoDir: string): void {
    fs.mkdirSync(path.join(repoDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "dist", "cli.js"),
      "if (process.argv.includes('--help')) process.exit(0);\n",
    );
    fs.mkdirSync(path.join(repoDir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ version: "2.8.2" }));
    fs.writeFileSync(path.join(repoDir, "README.md"), "# nanos-lint");
    fs.writeFileSync(path.join(repoDir, "LICENSE"), "MIT");
  }

  it("drives full packaging pipeline for tar.gz and preserves pre-existing user annotations.lua", async () => {
    setupRepoFiles(tmpRepo);

    // Sentinel user-authored annotations.lua in repo root must NEVER be deleted or overwritten
    const userAnnotations = path.join(tmpRepo, "annotations.lua");
    const sentinelContent = "-- USER AUTHORED ANNOTATIONS, DO NOT DELETE\n";
    fs.writeFileSync(userAnnotations, sentinelContent);

    const commitSha = "beefcafe1234567890abcdef1234567890abcdef";
    const annotationsContent = "-- Annotations\n" + "x = 1\n".repeat(250);
    const tarGzArchive = createValidLualsTarGz();

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("commits/docgen-output")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ sha: commitSha })),
          json: () => Promise.resolve({ sha: commitSha }),
        } as unknown as Response);
      }
      if (u.includes(commitSha)) {
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          text: () => Promise.resolve(annotationsContent),
        } as unknown as Response);
      }
      if (u.includes("lua-language-server") && u.endsWith(".tar.gz")) {
        return Promise.resolve({
          ok: true,
          url: "https://github.com/LuaLS/lua-language-server/releases/download/3.19.1/lua-language-server-3.19.1-linux-x64.tar.gz",
          headers: new Headers(),
          body: Readable.from([tarGzArchive]),
        } as unknown as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const result = await packageRelease("v2.8.2", {
      repoRoot: tmpRepo,
      targetIds: ["linux-x64"],
      lualsVersion: "3.19.1",
    });

    expect(result.outputArchives.length).toBe(1);
    expect(fs.existsSync(result.outputArchives[0]!)).toBe(true);

    expect(fs.existsSync(result.sumsPath)).toBe(true);
    const sums = fs.readFileSync(result.sumsPath, "utf-8");
    expect(sums).toContain("nanos-lint-v2.8.2-linux-x64.tar.gz");
    expect(sums).toContain(commitSha);
    expect(sums).toContain("3.19.1");

    // Pre-existing user-authored annotations.lua must remain intact!
    expect(fs.existsSync(userAnnotations)).toBe(true);
    expect(fs.readFileSync(userAnnotations, "utf-8")).toBe(sentinelContent);

    // Ephemeral workDir must be cleaned up
    expect(fs.existsSync(path.join(tmpRepo, ".package-release-tmp"))).toBe(false);
  });

  it.skipIf(!canCreateZip() || !canExtractZip())(
    "drives full packaging pipeline for zip target and creates SHA256SUMS",
    async () => {
      setupRepoFiles(tmpRepo);

      const commitSha = "beefcafe1234567890abcdef1234567890abcdef";
      const annotationsContent = "-- Annotations\n" + "x = 1\n".repeat(250);
      const zipArchive = createValidLualsZip();

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes("commits/docgen-output")) {
          return Promise.resolve({
            ok: true,
            headers: new Headers(),
            text: () => Promise.resolve(JSON.stringify({ sha: commitSha })),
            json: () => Promise.resolve({ sha: commitSha }),
          } as unknown as Response);
        }
        if (u.includes(commitSha)) {
          return Promise.resolve({
            ok: true,
            headers: new Headers(),
            text: () => Promise.resolve(annotationsContent),
          } as unknown as Response);
        }
        if (u.includes("lua-language-server") && u.endsWith(".zip")) {
          return Promise.resolve({
            ok: true,
            url: "https://github.com/LuaLS/lua-language-server/releases/download/3.19.1/lua-language-server-3.19.1-win32-x64.zip",
            headers: new Headers(),
            body: Readable.from([zipArchive]),
          } as unknown as Response);
        }
        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
      });

      const result = await packageRelease("v2.8.2", {
        repoRoot: tmpRepo,
        targetIds: ["windows-x64"],
        lualsVersion: "3.19.1",
      });

      expect(result.outputArchives.length).toBe(1);
      expect(fs.existsSync(result.outputArchives[0]!)).toBe(true);

      expect(fs.existsSync(result.sumsPath)).toBe(true);
      const sums = fs.readFileSync(result.sumsPath, "utf-8");
      expect(sums).toContain("nanos-lint-v2.8.2-windows-x64.zip");
      expect(sums).toContain(commitSha);
      expect(sums).toContain("3.19.1");

      expect(fs.existsSync(path.join(tmpRepo, ".package-release-tmp"))).toBe(false);
    },
  );
});
