import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  inspectZipMembers,
  validateArchiveMembers,
  MAX_ARCHIVE_MEMBER_COUNT,
  MAX_DECOMPRESSED_SIZE_BYTES,
} from "../../src/luals.js";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SENTINEL_UINT16 = 0xffff;
const SENTINEL_UINT32 = 0xffffffff;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const MODE_FILE = 0o100644;
const MODE_SYMLINK = 0o120777;

/** Serializes an unsigned 64-bit little-endian ZIP64 field. */
function uint64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

/** Serializes a 32-bit little-endian ZIP64 field. */
function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

/** Serializes an extra field with its 4-byte header. */
function extraField(id: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(id, 0);
  head.writeUInt16LE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

/** Serializes an extra field header declaring more data than the archive holds. */
function malformedExtraFieldHeader(id: number, size: number): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(id, 0);
  head.writeUInt16LE(size, 2);
  return head;
}

interface ZipEntrySpec {
  name: string;
  data?: Buffer;
  mode?: number;
  flags?: number;
  zip64?: boolean;
  localName?: string;
  localExtra?: Buffer;
  centralExtra?: Buffer;
  zip64ExtraBytes?: Buffer;
  omitZip64Extra?: boolean;
  localSignature?: number;
  localSize?: number;
  localCompressedSize?: number;
  centralLocalOffset?: number;
  diskStart?: number;
  zip64DiskStart?: number;
}

interface ZipArchiveSpec {
  entries: ZipEntrySpec[];
  comment?: Buffer;
  trailing?: Buffer;
  garbageAfterCentralDirectory?: Buffer;
  zip64Eocd?: boolean;
  zip64EocdSentinels?: boolean;
  omitZip64Locator?: boolean;
  zip64RecordSize?: number;
  zip64RecordOffset?: number;
  zip64EntryCount?: number | bigint;
  zip64OnDiskCount?: number | bigint;
  zip64CdSize?: number | bigint;
  zip64CdOffset?: number | bigint;
  zip64DiskNumber?: number;
  declaredEntryCount?: number;
  declaredEntryCountOnDisk?: number;
  declaredCdSize?: number;
  declaredCdOffset?: number;
  diskNumber?: number;
  cdStartDisk?: number;
}

/** Builds a ZIP archive whose every structural field can be overridden for adversarial tests. */
function buildZip(spec: ZipArchiveSpec): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of spec.entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const localNameBytes = Buffer.from(entry.localName ?? entry.name, "utf-8");
    const zip64Local =
      entry.zip64 && !entry.omitZip64Extra
        ? extraField(0x0001, Buffer.concat([uint64(data.length), uint64(data.length)]))
        : Buffer.alloc(0);
    const localExtra = Buffer.concat([entry.localExtra ?? Buffer.alloc(0), zip64Local]);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(entry.localSignature ?? SIG_LOCAL, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(entry.flags ?? 0, 6);
    localHeader.writeUInt32LE(
      entry.localCompressedSize ?? (entry.zip64 ? SENTINEL_UINT32 : data.length),
      18,
    );
    localHeader.writeUInt32LE(entry.localSize ?? (entry.zip64 ? SENTINEL_UINT32 : data.length), 22);
    localHeader.writeUInt16LE(localNameBytes.length, 26);
    localHeader.writeUInt16LE(localExtra.length, 28);
    localParts.push(localHeader, localNameBytes, localExtra, data);

    const diskStart = entry.diskStart ?? 0;
    const zip64Fields: Buffer[] = entry.zip64
      ? [uint64(data.length), uint64(data.length), uint64(entry.centralLocalOffset ?? offset)]
      : [];
    if (diskStart === SENTINEL_UINT16 || entry.zip64DiskStart !== undefined) {
      zip64Fields.push(uint32(entry.zip64DiskStart ?? 0));
    }
    const payload = entry.zip64ExtraBytes ?? Buffer.concat(zip64Fields);
    const centralZip64 =
      payload.length > 0 && !(entry.omitZip64Extra && !entry.zip64ExtraBytes)
        ? extraField(0x0001, payload)
        : Buffer.alloc(0);
    const centralExtra = Buffer.concat([entry.centralExtra ?? Buffer.alloc(0), centralZip64]);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(SIG_CENTRAL, 0);
    centralHeader.writeUInt16LE(0x031e, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(entry.flags ?? 0, 8);
    centralHeader.writeUInt32LE(entry.zip64 ? SENTINEL_UINT32 : data.length, 20);
    centralHeader.writeUInt32LE(entry.zip64 ? SENTINEL_UINT32 : data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(centralExtra.length, 30);
    centralHeader.writeUInt16LE(diskStart, 34);
    centralHeader.writeUInt32LE(((entry.mode ?? MODE_FILE) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(
      entry.zip64 ? SENTINEL_UINT32 : (entry.centralLocalOffset ?? offset),
      42,
    );
    centralParts.push(centralHeader, nameBytes, centralExtra);
    offset += localHeader.length + localNameBytes.length + localExtra.length + data.length;
  }

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const cdOffset = local.length;
  const entryCount = spec.entries.length;
  const tail: Buffer[] = [local, central, spec.garbageAfterCentralDirectory ?? Buffer.alloc(0)];

  let zip64RecordOffset: number | undefined;
  if (spec.zip64Eocd) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(SIG_ZIP64_EOCD, 0);
    record.writeBigUInt64LE(BigInt(spec.zip64RecordSize ?? 44), 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeUInt32LE(spec.zip64DiskNumber ?? 0, 16);
    record.writeUInt32LE(spec.zip64DiskNumber ?? 0, 20);
    record.writeBigUInt64LE(
      BigInt(spec.zip64OnDiskCount ?? spec.zip64EntryCount ?? entryCount),
      24,
    );
    record.writeBigUInt64LE(BigInt(spec.zip64EntryCount ?? entryCount), 32);
    record.writeBigUInt64LE(BigInt(spec.zip64CdSize ?? central.length), 40);
    record.writeBigUInt64LE(BigInt(spec.zip64CdOffset ?? cdOffset), 48);
    zip64RecordOffset = cdOffset + central.length;
    tail.push(record);
    if (!spec.omitZip64Locator) {
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
      locator.writeBigUInt64LE(BigInt(spec.zip64RecordOffset ?? zip64RecordOffset), 8);
      locator.writeUInt32LE(1, 16);
      tail.push(locator);
    }
  }

  const sentinels = spec.zip64EocdSentinels ?? Boolean(spec.zip64Eocd);
  const comment = spec.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(spec.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(spec.cdStartDisk ?? 0, 6);
  eocd.writeUInt16LE(
    spec.declaredEntryCountOnDisk ?? (sentinels ? SENTINEL_UINT16 : entryCount),
    8,
  );
  eocd.writeUInt16LE(spec.declaredEntryCount ?? (sentinels ? SENTINEL_UINT16 : entryCount), 10);
  eocd.writeUInt32LE(spec.declaredCdSize ?? (sentinels ? SENTINEL_UINT32 : central.length), 12);
  eocd.writeUInt32LE(spec.declaredCdOffset ?? (sentinels ? SENTINEL_UINT32 : cdOffset), 16);
  eocd.writeUInt16LE(comment.length, 20);
  tail.push(eocd, comment, spec.trailing ?? Buffer.alloc(0));
  return Buffer.concat(tail);
}

let tempDir = "";
let fileSeq = 0;

/** Writes an archive buffer to disk and returns its path. */
function zipFile(buffer: Buffer): string {
  const file = path.join(tempDir, `archive-${fileSeq++}.zip`);
  fs.writeFileSync(file, buffer);
  return file;
}

/** Asserts that an archive buffer is rejected by the pre-extraction inspection. */
function expectRejected(buffer: Buffer, pattern: RegExp): void {
  expect(() => inspectZipMembers(zipFile(buffer))).toThrow(pattern);
}

const binary = Buffer.from("lua-language-server binary payload");
const simpleEntries = (): ZipEntrySpec[] => [
  { name: "bin/lua-language-server.exe", data: binary },
  { name: "bin/annotations.lua", data: Buffer.alloc(50, 1) },
];

describe("inspectZipMembers central directory inspection", () => {
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-zip-validation-"));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts a well-formed archive and reports its members", () => {
    expect(inspectZipMembers(zipFile(buildZip({ entries: simpleEntries() })))).toEqual({
      memberCount: 2,
      totalDeclaredSize: binary.length + 50,
    });
  });

  it("accepts a well-formed ZIP64 archive and reads sizes from the extra field", () => {
    const entries = simpleEntries().map((entry) => ({ ...entry, zip64: true }));
    const archive = buildZip({ entries, zip64Eocd: true });
    expect(inspectZipMembers(zipFile(archive))).toEqual({
      memberCount: 2,
      totalDeclaredSize: binary.length + 50,
    });
  });

  it("accepts a ZIP64 archive whose 32-bit EOCD fields are honest", () => {
    const archive = buildZip({
      entries: simpleEntries(),
      zip64Eocd: true,
      zip64EocdSentinels: false,
    });
    expect(inspectZipMembers(zipFile(archive))).toEqual({
      memberCount: 2,
      totalDeclaredSize: binary.length + 50,
    });
  });

  it("accepts members written with a trailing data descriptor", () => {
    const archive = buildZip({
      entries: [
        {
          name: "bin/lua-language-server.exe",
          data: binary,
          flags: FLAG_DATA_DESCRIPTOR,
          localSize: 0,
          localCompressedSize: 0,
        },
      ],
    });
    expect(inspectZipMembers(zipFile(archive)).memberCount).toBe(1);
  });

  it("accepts an EOCD comment and trailing data after it", () => {
    const archive = buildZip({
      entries: simpleEntries(),
      comment: Buffer.from("release comment"),
      trailing: Buffer.from("junk"),
    });
    expect(inspectZipMembers(zipFile(archive)).memberCount).toBe(2);
  });

  it("rejects the zeroed-entry-count bypass with a path escape and a symlink", () => {
    const archive = buildZip({
      entries: [
        { name: "../../../../Users/Public/evil.txt", data: Buffer.from("PWNED\n") },
        {
          name: "bin/lua-language-server-link",
          data: Buffer.from("/etc/passwd"),
          mode: MODE_SYMLINK,
        },
        { name: "bin/lua-language-server.exe", data: Buffer.from("x".repeat(100)) },
      ],
      declaredEntryCount: 0,
      declaredEntryCountOnDisk: 0,
    });
    expectRejected(archive, /central directory declares zero members/);
  });

  it("rejects zeroed 32-bit EOCD fields that hide a populated ZIP64 record", () => {
    const archive = buildZip({
      entries: simpleEntries().map((entry) => ({ ...entry, zip64: true })),
      zip64Eocd: true,
      declaredEntryCount: 0,
      declaredEntryCountOnDisk: 0,
      declaredCdSize: 0,
      declaredCdOffset: 0,
    });
    expectRejected(archive, /disagrees with the EOCD fields/);
  });

  it("rejects an empty archive instead of reporting zero members", () => {
    expectRejected(buildZip({ entries: [] }), /central directory declares zero members/);
  });

  it("rejects a central directory offset outside the archive", () => {
    expectRejected(
      buildZip({ entries: simpleEntries(), declaredCdOffset: 0x7fffffff }),
      /central directory extends past the end of the archive/,
    );
  });

  it("rejects a central directory size that overruns the archive", () => {
    expectRejected(
      buildZip({ entries: simpleEntries(), declaredCdSize: 10_000_000 }),
      /central directory extends past the end of the archive/,
    );
  });

  it("rejects a truncated central directory", () => {
    const archive = buildZip({ entries: simpleEntries() });
    const eocd = archive.subarray(archive.length - 22);
    const cut = eocd.readUInt32LE(16) + eocd.readUInt32LE(12) - 10;
    expectRejected(
      Buffer.concat([archive.subarray(0, cut), eocd]),
      /local file header name does not match|central directory extends past the end of the archive/,
    );
    expectRejected(archive.subarray(0, cut), /missing EOCD/);
  });

  it("rejects a declared member count that disagrees with the walked records", () => {
    expectRejected(
      buildZip({ entries: simpleEntries(), declaredEntryCount: 3, declaredEntryCountOnDisk: 3 }),
      /central directory contains 2 member\(s\) but declares 3/,
    );
  });

  it("rejects a declared count higher than the member limit before walking", () => {
    expectRejected(
      buildZip({
        entries: simpleEntries(),
        declaredEntryCount: MAX_ARCHIVE_MEMBER_COUNT + 1,
        declaredEntryCountOnDisk: MAX_ARCHIVE_MEMBER_COUNT + 1,
      }),
      /member count.*exceeds maximum limit/,
    );
  });

  it("rejects an inconsistent entry count on disk", () => {
    expectRejected(
      buildZip({ entries: simpleEntries(), declaredEntryCountOnDisk: 5 }),
      /multi-disk or inconsistent end of central directory record/,
    );
  });

  it("rejects a central directory whose size runs into the end record", () => {
    const archive = buildZip({ entries: simpleEntries() });
    const eocd = archive.subarray(archive.length - 22);
    expectRejected(
      buildZip({ entries: simpleEntries(), declaredCdSize: eocd.readUInt32LE(12) + 22 }),
      /truncated or corrupt central directory record/,
    );
  });

  it("rejects a central directory size that does not match the walked records", () => {
    const oversized = buildZip({ entries: simpleEntries() });
    const eocd = oversized.subarray(oversized.length - 22);
    const cdSize = eocd.readUInt32LE(12);
    expectRejected(
      buildZip({ entries: simpleEntries(), declaredCdSize: cdSize + 4 }),
      /truncated or corrupt central directory record/,
    );
    expectRejected(
      buildZip({ entries: simpleEntries(), declaredCdSize: cdSize - 1 }),
      /central directory records overrun the declared central directory size/,
    );
  });

  it("rejects a central directory that does not end at the EOCD", () => {
    expectRejected(
      buildZip({ entries: simpleEntries(), garbageAfterCentralDirectory: Buffer.from("JUNK") }),
      /not terminated by an end of central directory record/,
    );
  });

  it("rejects central directories terminated by a misplaced or malformed end record", () => {
    const archive = buildZip({ entries: simpleEntries() });
    const body = archive.subarray(0, archive.length - 22);
    const eocd = archive.subarray(archive.length - 22);
    // An EOCD signature at the central directory end that is not the scanned EOCD.
    expectRejected(
      Buffer.concat([body, eocd, eocd]),
      /does not end at the end of central directory record/,
    );
    // A ZIP64 end record signature with too little room for the record itself.
    const bareSignature = Buffer.alloc(4);
    bareSignature.writeUInt32LE(SIG_ZIP64_EOCD, 0);
    expectRejected(
      Buffer.concat([body, bareSignature, eocd]),
      /truncated ZIP64 end of central directory record/,
    );
    // A zeroed ZIP64 end record that does not line up with its locator.
    const emptyRecord = Buffer.alloc(56);
    emptyRecord.writeUInt32LE(SIG_ZIP64_EOCD, 0);
    expectRejected(
      Buffer.concat([body, emptyRecord, eocd]),
      /not terminated by a valid ZIP64 end of central directory record/,
    );
  });

  it("rejects archives without an EOCD and archives too small to be a zip", () => {
    expectRejected(Buffer.alloc(64, 7), /missing EOCD/);
    expectRejected(Buffer.alloc(10, 7), /too small to be a valid zip/);
  });

  it("rejects multi-disk archives", () => {
    expectRejected(
      buildZip({ entries: simpleEntries(), diskNumber: 1 }),
      /multi-disk or inconsistent/,
    );
    expectRejected(buildZip({ entries: simpleEntries(), cdStartDisk: 1 }), /multi-disk/);
    expectRejected(
      buildZip({ entries: [{ ...simpleEntries()[0]!, diskStart: 1 }] }),
      /multi-disk zip archives are not supported/,
    );
    expectRejected(
      buildZip({ entries: simpleEntries(), zip64Eocd: true, zip64DiskNumber: 1 }),
      /multi-disk or inconsistent ZIP64/,
    );
  });

  it("rejects ZIP64 sentinels without usable ZIP64 records", () => {
    expectRejected(
      buildZip({ entries: simpleEntries(), declaredCdOffset: SENTINEL_UINT32 }),
      /missing or corrupt ZIP64 end of central directory locator/,
    );
    expectRejected(
      buildZip({ entries: simpleEntries(), zip64Eocd: true, omitZip64Locator: true }),
      /missing or corrupt ZIP64 end of central directory locator/,
    );
    expectRejected(
      buildZip({ entries: simpleEntries(), zip64Eocd: true, zip64RecordOffset: 0 }),
      /missing or corrupt ZIP64 end of central directory record/,
    );
    expectRejected(
      buildZip({ entries: simpleEntries(), zip64Eocd: true, zip64RecordSize: 45 }),
      /does not end at its locator/,
    );
  });

  it("rejects ZIP64 records that disagree with the EOCD fields", () => {
    expectRejected(
      buildZip({
        entries: simpleEntries(),
        zip64Eocd: true,
        zip64EocdSentinels: false,
        zip64EntryCount: 5,
        zip64OnDiskCount: 5,
      }),
      /disagrees with the EOCD fields/,
    );
    expectRejected(
      buildZip({
        entries: simpleEntries(),
        zip64Eocd: true,
        zip64OnDiskCount: 5,
      }),
      /multi-disk or inconsistent ZIP64/,
    );
    expectRejected(
      buildZip({ entries: simpleEntries(), zip64Eocd: true, zip64EntryCount: 2n ** 63n }),
      /exceeds the supported range/,
    );
  });

  it("rejects ZIP64 sentinels without the extended information extra field", () => {
    const zip64Entry = { ...simpleEntries()[0]!, zip64: true };
    expectRejected(
      buildZip({ entries: [{ ...zip64Entry, omitZip64Extra: true }] }),
      /missing its ZIP64 extended information/,
    );
    expectRejected(
      buildZip({ entries: [{ ...zip64Entry, zip64ExtraBytes: uint64(binary.length) }] }),
      /truncated ZIP64 extended information extra field \(compressed size\)/,
    );
    expectRejected(
      buildZip({
        entries: [
          {
            ...zip64Entry,
            zip64ExtraBytes: Buffer.concat([
              uint64(binary.length),
              uint64(binary.length),
              uint64(0),
            ]),
            diskStart: SENTINEL_UINT16,
          },
        ],
      }),
      /truncated ZIP64 extended information extra field \(disk start\)/,
    );
    expectRejected(
      buildZip({
        entries: [
          {
            ...zip64Entry,
            omitZip64Extra: true,
            centralExtra: Buffer.concat([malformedExtraFieldHeader(0x0001, 64), Buffer.alloc(8)]),
          },
        ],
      }),
      /missing its ZIP64 extended information/,
    );
  });

  it("accepts ZIP64 entries with unknown extra fields and a zero disk start", () => {
    const archive = buildZip({
      entries: [
        {
          ...simpleEntries()[0]!,
          zip64: true,
          centralExtra: extraField(0x5455, Buffer.alloc(4)),
          diskStart: SENTINEL_UINT16,
          zip64DiskStart: 0,
        },
      ],
    });
    expect(inspectZipMembers(zipFile(archive)).memberCount).toBe(1);
  });

  it("rejects a member whose ZIP64 size exceeds the decompressed size limit", () => {
    const oversized = MAX_DECOMPRESSED_SIZE_BYTES + 1;
    expectRejected(
      buildZip({
        entries: [
          {
            name: "huge.bin",
            zip64: true,
            omitZip64Extra: true,
            localExtra: extraField(0x0001, Buffer.concat([uint64(oversized), uint64(0)])),
            zip64ExtraBytes: Buffer.concat([uint64(oversized), uint64(0), uint64(0)]),
          },
        ],
      }),
      /declared decompressed size.*exceeds maximum limit/,
    );
  });

  it("rejects symlink, escaping, drive-relative and UNC member names", () => {
    expectRejected(
      buildZip({ entries: [{ name: "link", mode: MODE_SYMLINK }] }),
      /symbolic or hard link/,
    );
    expectRejected(
      buildZip({ entries: [{ name: "../evil.sh" }] }),
      /Archive member path escapes extraction directory/,
    );
    expectRejected(
      buildZip({ entries: [{ name: "bin\\..\\..\\evil.sh" }] }),
      /Archive member path escapes extraction directory/,
    );
    expectRejected(
      buildZip({ entries: [{ name: "C:evil.sh" }] }),
      /Archive member path escapes extraction directory/,
    );
    expectRejected(
      buildZip({ entries: [{ name: "\\\\server\\share\\evil.sh" }] }),
      /Archive member path escapes extraction directory/,
    );
  });

  it("rejects local file headers that disagree with the central directory", () => {
    expectRejected(
      buildZip({ entries: [{ name: "safe.bin", localName: "../evil.sh", data: binary }] }),
      /local file header name does not match/,
    );
    expectRejected(
      buildZip({ entries: [{ name: "safe.bin", data: binary, localSize: binary.length - 1 }] }),
      /local file header sizes do not match/,
    );
    expectRejected(
      buildZip({ entries: [{ name: "safe.bin", data: binary, localSignature: 0 }] }),
      /local file header is missing/,
    );
    expectRejected(
      buildZip({ entries: [{ name: "safe.bin", data: binary, centralLocalOffset: 0x7ffffff0 }] }),
      /local file header is missing/,
    );
    expectRejected(
      buildZip({
        entries: [
          {
            name: "safe.bin",
            data: binary,
            localSize: SENTINEL_UINT32,
            localCompressedSize: SENTINEL_UINT32,
          },
        ],
      }),
      /local file header is missing its ZIP64 extended information/,
    );
    expectRejected(
      buildZip({
        entries: [
          {
            name: "safe.bin",
            data: binary,
            localSize: SENTINEL_UINT32,
            localCompressedSize: SENTINEL_UINT32,
            localExtra: extraField(0x0001, uint64(binary.length)),
          },
        ],
      }),
      /truncated ZIP64 extended information extra field \(compressed size\)/,
    );
  });

  it("rejects a truncated local file header", () => {
    const archive = buildZip({ entries: simpleEntries() });
    archive.writeUInt16LE(SENTINEL_UINT16, 28);
    expectRejected(archive, /truncated local file header/);
  });

  it("is exercised through validateArchiveMembers for .zip assets", async () => {
    const good = zipFile(buildZip({ entries: simpleEntries() }));
    await expect(validateArchiveMembers(good)).resolves.toEqual({
      memberCount: 2,
      totalDeclaredSize: binary.length + 50,
    });
    const bypass = zipFile(
      buildZip({
        entries: [{ name: "../evil.sh" }],
        declaredEntryCount: 0,
        declaredEntryCountOnDisk: 0,
      }),
    );
    await expect(validateArchiveMembers(bypass)).rejects.toThrow(/declares zero members/);
  });
});
