import { LuaLSError } from "../errors.js";

/**
 * Structural ZIP parsing for the pre-extraction archive inspection. These
 * helpers read end records, central directory records and local file headers,
 * and resolve the ZIP64 structures whenever a 32-bit field is a sentinel.
 * Declared counts, offsets and sizes are surfaced to the caller but bounded
 * here, so a hostile archive can never make the inspector read out of bounds.
 */

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP_SENTINEL_UINT16 = 0xffff;
const ZIP_SENTINEL_UINT32 = 0xffffffff;
export const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_SIZE = 0xffff;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_MIN_SIZE = 56;
const ZIP_CENTRAL_HEADER_SIZE = 46;
const ZIP_LOCAL_HEADER_SIZE = 30;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;

/**
 * Builds the pre-extraction inspection failure reported for every rejected
 * archive, so a fail-closed rejection always carries the same remediation.
 */
export function invalidZipArchive(reason: string): LuaLSError {
  return new LuaLSError(
    `Failed to inspect release archive before extraction: ${reason}`,
    "ERR_LUALS_EXTRACT",
    "Run 'nanos-lint clean-cache' and verify the LuaLS release integrity.",
  );
}

/** Converts an unsigned 64-bit ZIP field to a number, rejecting values above Number.MAX_SAFE_INTEGER. */
function zip64ToNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidZipArchive(`${what} exceeds the supported range`);
  }
  return Number(value);
}

/** Locates the ZIP End Of Central Directory record, preferring one whose comment ends the file. */
export function findEndOfCentralDirectory(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - ZIP_EOCD_MIN_SIZE - ZIP_MAX_COMMENT_SIZE);
  let fallback = -1;
  for (let i = buf.length - ZIP_EOCD_MIN_SIZE; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    if (i + ZIP_EOCD_MIN_SIZE + buf.readUInt16LE(i + 20) === buf.length) return i;
    if (fallback === -1) fallback = i;
  }
  return fallback;
}

/** Central directory location and record count declared by an archive's end records. */
export interface ZipCentralDirectoryLocation {
  entryCount: number;
  cdOffset: number;
  cdSize: number;
}

/**
 * Resolves the central directory offset, size and record count, following the
 * ZIP64 locator and end record whenever one is present or any 32-bit EOCD field
 * is a sentinel. Declared values are never trusted on their own: the caller
 * walks the directory and reconciles every record against them.
 */
export function resolveCentralDirectoryLocation(
  buf: Buffer,
  eocdOffset: number,
): ZipCentralDirectoryLocation {
  const declared = {
    diskNumber: buf.readUInt16LE(eocdOffset + 4),
    cdStartDisk: buf.readUInt16LE(eocdOffset + 6),
    entriesOnDisk: buf.readUInt16LE(eocdOffset + 8),
    entryCount: buf.readUInt16LE(eocdOffset + 10),
    cdSize: buf.readUInt32LE(eocdOffset + 12),
    cdOffset: buf.readUInt32LE(eocdOffset + 16),
  };

  const needsZip64 =
    declared.diskNumber === ZIP_SENTINEL_UINT16 ||
    declared.cdStartDisk === ZIP_SENTINEL_UINT16 ||
    declared.entriesOnDisk === ZIP_SENTINEL_UINT16 ||
    declared.entryCount === ZIP_SENTINEL_UINT16 ||
    declared.cdSize === ZIP_SENTINEL_UINT32 ||
    declared.cdOffset === ZIP_SENTINEL_UINT32;

  // A ZIP64 end record is authoritative even when the 32-bit fields are not
  // sentinels, so its values are always reconciled when the locator is present.
  const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
  const hasZip64Locator =
    locatorOffset >= 0 &&
    buf.readUInt32LE(locatorOffset) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE;
  if (hasZip64Locator) {
    return readZip64CentralDirectoryLocation(buf, eocdOffset, declared);
  }
  if (needsZip64) {
    throw invalidZipArchive("missing or corrupt ZIP64 end of central directory locator");
  }
  if (
    declared.diskNumber !== 0 ||
    declared.cdStartDisk !== 0 ||
    declared.entriesOnDisk !== declared.entryCount
  ) {
    throw invalidZipArchive("multi-disk or inconsistent end of central directory record");
  }
  return {
    entryCount: declared.entryCount,
    cdOffset: declared.cdOffset,
    cdSize: declared.cdSize,
  };
}

/** Reads the ZIP64 locator and end of central directory record carrying the 64-bit directory location. */
function readZip64CentralDirectoryLocation(
  buf: Buffer,
  eocdOffset: number,
  declared: { entryCount: number; cdSize: number; cdOffset: number },
): ZipCentralDirectoryLocation {
  const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
  if (
    locatorOffset < 0 ||
    buf.readUInt32LE(locatorOffset) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE
  ) {
    throw invalidZipArchive("missing or corrupt ZIP64 end of central directory locator");
  }

  const recordOffset = zip64ToNumber(
    buf.readBigUInt64LE(locatorOffset + 8),
    "ZIP64 end of central directory offset",
  );
  if (
    recordOffset + ZIP64_EOCD_MIN_SIZE > buf.length ||
    buf.readUInt32LE(recordOffset) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE
  ) {
    throw invalidZipArchive("missing or corrupt ZIP64 end of central directory record");
  }

  const recordSize = zip64ToNumber(
    buf.readBigUInt64LE(recordOffset + 4),
    "ZIP64 end of central directory size",
  );
  if (recordOffset + 12 + recordSize !== locatorOffset) {
    throw invalidZipArchive("ZIP64 end of central directory record does not end at its locator");
  }

  const diskNumber = buf.readUInt32LE(recordOffset + 16);
  const cdStartDisk = buf.readUInt32LE(recordOffset + 20);
  const entriesOnDisk = zip64ToNumber(buf.readBigUInt64LE(recordOffset + 24), "ZIP64 entry count");
  const entryCount = zip64ToNumber(buf.readBigUInt64LE(recordOffset + 32), "ZIP64 entry count");
  const cdSize = zip64ToNumber(
    buf.readBigUInt64LE(recordOffset + 40),
    "ZIP64 central directory size",
  );
  const cdOffset = zip64ToNumber(
    buf.readBigUInt64LE(recordOffset + 48),
    "ZIP64 central directory offset",
  );

  if (diskNumber !== 0 || cdStartDisk !== 0 || entriesOnDisk !== entryCount) {
    throw invalidZipArchive("multi-disk or inconsistent ZIP64 end of central directory record");
  }
  if (
    (declared.entryCount !== ZIP_SENTINEL_UINT16 && declared.entryCount !== entryCount) ||
    (declared.cdSize !== ZIP_SENTINEL_UINT32 && declared.cdSize !== cdSize) ||
    (declared.cdOffset !== ZIP_SENTINEL_UINT32 && declared.cdOffset !== cdOffset)
  ) {
    throw invalidZipArchive("ZIP64 end of central directory record disagrees with the EOCD fields");
  }
  return { entryCount, cdOffset, cdSize };
}

/** Returns the payload of the ZIP64 extended information extra field (0x0001), when present. */
function findZip64ExtraField(extra: Buffer): Buffer | undefined {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(cursor);
    const dataSize = extra.readUInt16LE(cursor + 2);
    if (cursor + 4 + dataSize > extra.length) return undefined;
    if (headerId === ZIP64_EXTRA_FIELD_ID) {
      return extra.subarray(cursor + 4, cursor + 4 + dataSize);
    }
    cursor += 4 + dataSize;
  }
  return undefined;
}

/** Reads one 8-byte ZIP64 extended information value, rejecting a truncated extra field. */
function readZip64ExtraValue(data: Buffer, byteOffset: number, what: string): number {
  if (byteOffset + 8 > data.length) {
    throw invalidZipArchive(`truncated ZIP64 extended information extra field (${what})`);
  }
  return zip64ToNumber(data.readBigUInt64LE(byteOffset), `ZIP64 ${what}`);
}

/** Resolves a central directory record's 64-bit values from its ZIP64 extended information extra field. */
function resolveZip64Values(
  extra: Buffer,
  base: {
    uncompressedSize: number;
    compressedSize: number;
    localHeaderOffset: number;
    diskStart: number;
  },
): { uncompressedSize: number; compressedSize: number; localHeaderOffset: number } {
  const needsZip64 =
    base.uncompressedSize === ZIP_SENTINEL_UINT32 ||
    base.compressedSize === ZIP_SENTINEL_UINT32 ||
    base.localHeaderOffset === ZIP_SENTINEL_UINT32 ||
    base.diskStart === ZIP_SENTINEL_UINT16;
  if (!needsZip64) {
    if (base.diskStart !== 0) {
      throw invalidZipArchive("multi-disk zip archives are not supported");
    }
    return base;
  }

  const data = findZip64ExtraField(extra);
  if (!data) {
    throw invalidZipArchive("central directory record is missing its ZIP64 extended information");
  }
  let cursor = 0;
  let { uncompressedSize, compressedSize, localHeaderOffset } = base;
  let diskStart = base.diskStart;
  if (uncompressedSize === ZIP_SENTINEL_UINT32) {
    uncompressedSize = readZip64ExtraValue(data, cursor, "uncompressed size");
    cursor += 8;
  }
  if (compressedSize === ZIP_SENTINEL_UINT32) {
    compressedSize = readZip64ExtraValue(data, cursor, "compressed size");
    cursor += 8;
  }
  if (localHeaderOffset === ZIP_SENTINEL_UINT32) {
    localHeaderOffset = readZip64ExtraValue(data, cursor, "local header offset");
    cursor += 8;
  }
  if (diskStart === ZIP_SENTINEL_UINT16) {
    if (cursor + 4 > data.length) {
      throw invalidZipArchive("truncated ZIP64 extended information extra field (disk start)");
    }
    diskStart = data.readUInt32LE(cursor);
  }
  if (diskStart !== 0) {
    throw invalidZipArchive("multi-disk zip archives are not supported");
  }
  return { uncompressedSize, compressedSize, localHeaderOffset };
}

/** One central directory record with its ZIP64 sentinels resolved. */
export interface ZipCentralDirectoryRecord {
  fileName: string;
  fileNameBytes: Buffer;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  unixFileType: number;
  hasDataDescriptor: boolean;
  nextOffset: number;
}

/**
 * Reads and structurally validates one central directory record, resolving the
 * ZIP64 extended information sentinels. Returns `undefined` when the bytes at
 * `offset` are not a central directory record, so the caller can tell a
 * finished walk apart from a corrupt one.
 */
export function readZipCentralDirectoryRecord(
  buf: Buffer,
  offset: number,
): ZipCentralDirectoryRecord | undefined {
  if (offset + ZIP_CENTRAL_HEADER_SIZE > buf.length) return undefined;
  if (buf.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER_SIGNATURE) return undefined;

  const flags = buf.readUInt16LE(offset + 8);
  const compressedSize = buf.readUInt32LE(offset + 20);
  const uncompressedSize = buf.readUInt32LE(offset + 24);
  const fileNameLen = buf.readUInt16LE(offset + 28);
  const extraLen = buf.readUInt16LE(offset + 30);
  const commentLen = buf.readUInt16LE(offset + 32);
  const diskStart = buf.readUInt16LE(offset + 34);
  const externalAttributes = buf.readUInt32LE(offset + 38);
  const localHeaderOffset = buf.readUInt32LE(offset + 42);
  const nameStart = offset + ZIP_CENTRAL_HEADER_SIZE;
  const nameEnd = nameStart + fileNameLen;
  const extraEnd = nameEnd + extraLen;
  const nextOffset = extraEnd + commentLen;
  if (nextOffset > buf.length) {
    throw invalidZipArchive("corrupt or truncated central directory record");
  }

  const values = resolveZip64Values(buf.subarray(nameEnd, extraEnd), {
    uncompressedSize,
    compressedSize,
    localHeaderOffset,
    diskStart,
  });
  return {
    fileName: buf.toString("utf-8", nameStart, nameEnd),
    fileNameBytes: buf.subarray(nameStart, nameEnd),
    compressedSize: values.compressedSize,
    uncompressedSize: values.uncompressedSize,
    localHeaderOffset: values.localHeaderOffset,
    unixFileType: (externalAttributes >>> 16) & ZIP_UNIX_FILE_TYPE_MASK,
    hasDataDescriptor: (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0,
    nextOffset,
  };
}

/** One local file header with its ZIP64 sentinels resolved. */
export interface ZipLocalFileHeaderRecord {
  fileName: string;
  fileNameBytes: Buffer;
  compressedSize: number;
  uncompressedSize: number;
  hasDataDescriptor: boolean;
}

/** Reads the local file header starting at `offset`, or `undefined` when none starts there. */
export function readZipLocalFileHeader(
  buf: Buffer,
  offset: number,
): ZipLocalFileHeaderRecord | undefined {
  if (offset + ZIP_LOCAL_HEADER_SIZE > buf.length) return undefined;
  if (buf.readUInt32LE(offset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) return undefined;

  const flags = buf.readUInt16LE(offset + 6);
  const fileNameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const nameStart = offset + ZIP_LOCAL_HEADER_SIZE;
  const nameEnd = nameStart + fileNameLen;
  const extraEnd = nameEnd + extraLen;
  if (extraEnd > buf.length) {
    throw invalidZipArchive("truncated local file header");
  }

  let compressedSize = buf.readUInt32LE(offset + 18);
  let uncompressedSize = buf.readUInt32LE(offset + 22);
  const hasDataDescriptor = (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
  if (
    !hasDataDescriptor &&
    (compressedSize === ZIP_SENTINEL_UINT32 || uncompressedSize === ZIP_SENTINEL_UINT32)
  ) {
    const data = findZip64ExtraField(buf.subarray(nameEnd, extraEnd));
    if (!data) {
      throw invalidZipArchive("local file header is missing its ZIP64 extended information");
    }
    let cursor = 0;
    if (uncompressedSize === ZIP_SENTINEL_UINT32) {
      uncompressedSize = readZip64ExtraValue(data, cursor, "uncompressed size");
      cursor += 8;
    }
    if (compressedSize === ZIP_SENTINEL_UINT32) {
      compressedSize = readZip64ExtraValue(data, cursor, "compressed size");
    }
  }

  return {
    fileName: buf.toString("utf-8", nameStart, nameEnd),
    fileNameBytes: buf.subarray(nameStart, nameEnd),
    compressedSize,
    uncompressedSize,
    hasDataDescriptor,
  };
}

/** Verifies that the walked central directory ends exactly at a valid end of central directory structure. */
export function assertCentralDirectoryTerminator(
  buf: Buffer,
  cdEnd: number,
  eocdOffset: number,
): void {
  if (cdEnd + 4 > buf.length) {
    throw invalidZipArchive(
      "central directory is not terminated by an end of central directory record",
    );
  }
  const signature = buf.readUInt32LE(cdEnd);
  if (signature === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    if (cdEnd !== eocdOffset) {
      throw invalidZipArchive(
        "central directory does not end at the end of central directory record",
      );
    }
    return;
  }
  if (signature !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    throw invalidZipArchive(
      "central directory is not terminated by an end of central directory record",
    );
  }
  if (cdEnd + ZIP64_EOCD_MIN_SIZE > buf.length) {
    throw invalidZipArchive("truncated ZIP64 end of central directory record");
  }
  const recordSize = zip64ToNumber(
    buf.readBigUInt64LE(cdEnd + 4),
    "ZIP64 end of central directory size",
  );
  const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
  if (
    locatorOffset < 0 ||
    cdEnd + 12 + recordSize !== locatorOffset ||
    buf.readUInt32LE(locatorOffset) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE ||
    zip64ToNumber(
      buf.readBigUInt64LE(locatorOffset + 8),
      "ZIP64 end of central directory offset",
    ) !== cdEnd
  ) {
    throw invalidZipArchive(
      "central directory is not terminated by a valid ZIP64 end of central directory record",
    );
  }
}
