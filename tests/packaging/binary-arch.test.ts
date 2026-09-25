import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { inspectBinaryArch, verifyBinaryArch } from "../../scripts/packaging/verify.js";

describe("binary architecture verification", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-pkg-test-arch-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  function createElfHeader(machine: number): Buffer {
    const buf = Buffer.alloc(64);
    buf.writeUInt32BE(0x7f454c46, 0); // ELF magic
    buf.writeUInt16LE(machine, 18);
    return buf;
  }

  function createMachOHeader(cpu: number): Buffer {
    const buf = Buffer.alloc(32);
    buf.writeUInt32LE(0xfeedfacf, 0); // Mach-O 64-bit magic
    buf.writeUInt32LE(cpu, 4);
    return buf;
  }

  function createPeHeader(machine: number): Buffer {
    const buf = Buffer.alloc(256);
    buf.write("MZ", 0, "ascii");
    buf.writeUInt32LE(0x80, 0x3c); // PE header offset at 0x3c
    buf.write("PE\u0000\u0000", 0x80, "ascii");
    buf.writeUInt16LE(machine, 0x84);
    return buf;
  }

  it("identifies ELF x64 and arm64 binaries", () => {
    const x64Elf = createElfHeader(0x3e);
    const arm64Elf = createElfHeader(0xb7);
    const unknownElf = createElfHeader(0x99);

    expect(inspectBinaryArch(x64Elf)).toBe("x64");
    expect(inspectBinaryArch(arm64Elf)).toBe("arm64");
    expect(inspectBinaryArch(unknownElf)).toBe("elf-153");
  });

  it("identifies Mach-O x64 and arm64 binaries", () => {
    const x64Macho = createMachOHeader(0x01000007);
    const arm64Macho = createMachOHeader(0x0100000c);
    const unknownMacho = createMachOHeader(0x01000009);

    expect(inspectBinaryArch(x64Macho)).toBe("x64");
    expect(inspectBinaryArch(arm64Macho)).toBe("arm64");
    expect(inspectBinaryArch(unknownMacho)).toBe("macho-16777225");
  });

  it("identifies PE x64 and arm64 binaries", () => {
    const x64Pe = createPeHeader(0x8664);
    const arm64Pe = createPeHeader(0xaa64);
    const unknownPe = createPeHeader(0x014c); // i386

    expect(inspectBinaryArch(x64Pe)).toBe("x64");
    expect(inspectBinaryArch(arm64Pe)).toBe("arm64");
    expect(inspectBinaryArch(unknownPe)).toBe("pe-332");
  });

  it("identifies unknown formats", () => {
    expect(inspectBinaryArch(Buffer.from("not a binary"))).toBe("unknown");
    expect(inspectBinaryArch(Buffer.alloc(0))).toBe("unknown");
  });

  it("verifyBinaryArch accepts matching architecture on disk", () => {
    const binFile = path.join(tmpDir, "sample-elf");
    fs.writeFileSync(binFile, createElfHeader(0x3e));
    expect(() => verifyBinaryArch(binFile, "x64")).not.toThrow();
  });

  it("verifyBinaryArch rejects mismatched architecture", () => {
    const binFile = path.join(tmpDir, "sample-arm-elf");
    fs.writeFileSync(binFile, createElfHeader(0xb7));
    expect(() => verifyBinaryArch(binFile, "x64")).toThrow(
      /Binary architecture mismatch.*expected x64 but detected arm64/,
    );
  });
});
