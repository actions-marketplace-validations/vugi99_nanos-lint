import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { packageRelease } from "../../scripts/package-release.js";

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

      const lh = Buffer.alloc(30 + fn.length + data.length);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
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

  it("drives full packaging pipeline for a target and creates SHA256SUMS", async () => {
    fs.mkdirSync(path.join(tmpRepo, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "dist", "cli.js"),
      "if (process.argv.includes('--help')) process.exit(0);\n",
    );
    fs.mkdirSync(path.join(tmpRepo, "templates"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "package.json"), JSON.stringify({ version: "2.8.2" }));
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "# nanos-lint");
    fs.writeFileSync(path.join(tmpRepo, "LICENSE"), "MIT");

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

    expect(fs.existsSync(path.join(tmpRepo, "annotations.lua"))).toBe(false);
    expect(fs.existsSync(path.join(tmpRepo, ".package-release-tmp"))).toBe(false);
  });
});
