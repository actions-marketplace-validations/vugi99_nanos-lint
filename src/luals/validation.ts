import fs from "node:fs";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../logger.js";
import { LuaLSError } from "../errors.js";
import {
  assertCentralDirectoryTerminator,
  assertLocalFileHeadersTileArchive,
  findEndOfCentralDirectory,
  invalidZipArchive,
  readZipCentralDirectoryRecord,
  readZipLocalFileHeader,
  resolveCentralDirectoryLocation,
  ZIP_EOCD_MIN_SIZE,
  type ZipCentralDirectoryLocation,
  type ZipCentralDirectoryRecord,
  type ZipLocalFileHeaderRecord,
  type ZipMemberPair,
} from "./zip.js";

const execFileAsync = promisify(execFile);

/**
 * Escapes single quotes for safe PowerShell single-quoted string interpolation.
 */
export function escapePowerShellSingleQuote(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * Maximum total decompressed size of a LuaLS release archive (500 MB).
 * Protects against zip bombs and maliciously inflated archives (#31).
 */
export const MAX_DECOMPRESSED_SIZE_BYTES = 500 * 1024 * 1024;

/**
 * Maximum number of members allowed in a LuaLS release archive (10,000).
 * Protects against inode exhaustion and archive recursion attacks (#31).
 */
export const MAX_ARCHIVE_MEMBER_COUNT = 10_000;

/** Parses the file size column from a 'tar -tvf' listing output line. */
export function parseTarTvSize(line: string): number {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return 0;
  const p1 = parts[1];
  const p2 = parts[2];
  const p4 = parts[4];
  if (p1 && p2 && p1.includes("/") && /^\d+$/.test(p2)) {
    return parseInt(p2, 10) || 0;
  }
  if (p4 && /^\d+$/.test(p4)) {
    return parseInt(p4, 10) || 0;
  }
  for (let i = 2; i < Math.min(parts.length - 1, 6); i++) {
    const p = parts[i];
    if (p && /^\d+$/.test(p)) {
      return parseInt(p, 10) || 0;
    }
  }
  return 0;
}

/**
 * Asserts that an archive entry name does not escape the destination directory.
 * Drive-letter paths are rejected whether absolute (`C:\evil`) or drive-relative
 * (`C:evil`), because Windows resolves the latter against the current directory
 * of that drive.
 */
function checkEscapedMember(member: string): void {
  if (
    member.startsWith("/") ||
    member.startsWith("\\") ||
    /^[a-zA-Z]:/.test(member) ||
    member.split(/[/\\]/).includes("..")
  ) {
    throw new LuaLSError(
      `Archive member path escapes extraction directory: ${member}`,
      "ERR_LUALS_EXTRACT",
      "Run 'nanos-lint clean-cache' and verify the LuaLS release integrity.",
    );
  }
}

/** Validates that archive entry count and decompressed size do not exceed safety limits. */
function checkArchiveLimits(count: number, size: number): void {
  if (count > MAX_ARCHIVE_MEMBER_COUNT) {
    throw new LuaLSError(
      `Archive member count (${count}) exceeds maximum limit (${MAX_ARCHIVE_MEMBER_COUNT})`,
      "ERR_LUALS_EXTRACT",
      "Run 'nanos-lint clean-cache' and verify the LuaLS release integrity.",
    );
  }
  if (size > MAX_DECOMPRESSED_SIZE_BYTES) {
    throw new LuaLSError(
      `Archive declared decompressed size (${size} bytes) exceeds maximum limit (${MAX_DECOMPRESSED_SIZE_BYTES} bytes)`,
      "ERR_LUALS_EXTRACT",
      "Run 'nanos-lint clean-cache' and ensure there is sufficient disk space.",
    );
  }
}

/** Locates the platform tar executable path, checking System32 on Windows. */
export function getTarBinary(): string {
  if (process.platform === "win32") {
    const sysTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(sysTar)) {
      return sysTar;
    }
  }
  return "tar";
}

/** Unix file type of a symbolic link entry, as stored in a zip external attributes field. */
const ZIP_UNIX_SYMLINK_TYPE = 0o120000;

/** Builds the refusal error for archive-planted symbolic or hard link members. */
function archiveLinkMemberError(): LuaLSError {
  return new LuaLSError(
    "Archive member is a symbolic or hard link. Refusing to extract archive-planted links.",
    "ERR_LUALS_EXTRACT",
    "Run 'nanos-lint clean-cache' and verify the LuaLS release integrity.",
  );
}

/**
 * Cross-checks a member's local file header against its central directory
 * record, so extraction cannot read a name, method or size the inspection never
 * validated.
 */
function checkLocalFileHeader(
  buf: Buffer,
  record: ZipCentralDirectoryRecord,
): ZipLocalFileHeaderRecord {
  const local = readZipLocalFileHeader(buf, record.localHeaderOffset);
  if (!local) {
    throw invalidZipArchive(`local file header is missing for '${record.fileName}'`);
  }
  if (!local.fileNameBytes.equals(record.fileNameBytes)) {
    throw invalidZipArchive(`local file header name does not match '${record.fileName}'`);
  }
  if (local.compressionMethod !== record.compressionMethod) {
    throw invalidZipArchive(
      `local file header compression method does not match '${record.fileName}'`,
    );
  }
  // With a data descriptor the sizes are only final after the member data, so
  // the local header legitimately carries zeros there.
  if (local.hasDataDescriptor || record.hasDataDescriptor) return local;
  if (
    local.uncompressedSize !== record.uncompressedSize ||
    local.compressedSize !== record.compressedSize
  ) {
    throw invalidZipArchive(`local file header sizes do not match '${record.fileName}'`);
  }
  return local;
}

/**
 * Walks every central directory record from the declared offset until the
 * declared central directory end, enforcing the extraction constraints on each
 * member and reconciling the walked records with the declared count. A walk
 * that cannot be completed is a rejection, never an empty archive.
 */
function walkCentralDirectory(
  buf: Buffer,
  eocdOffset: number,
  location: ZipCentralDirectoryLocation,
): { memberCount: number; totalDeclaredSize: number } {
  const { entryCount, cdOffset, cdSize } = location;
  if (entryCount === 0) {
    throw invalidZipArchive("central directory declares zero members");
  }
  checkArchiveLimits(entryCount, 0);

  const cdEnd = cdOffset + cdSize;
  if (cdEnd > buf.length) {
    throw invalidZipArchive("central directory extends past the end of the archive");
  }

  let offset = cdOffset;
  let memberCount = 0;
  let totalDeclaredSize = 0;
  const pairs: ZipMemberPair[] = [];
  while (offset < cdEnd) {
    const record = readZipCentralDirectoryRecord(buf, offset);
    if (!record) {
      throw invalidZipArchive("truncated or corrupt central directory record");
    }
    if (record.unixFileType === ZIP_UNIX_SYMLINK_TYPE) {
      throw archiveLinkMemberError();
    }
    checkEscapedMember(record.fileName);
    pairs.push({ record, local: checkLocalFileHeader(buf, record) });
    memberCount++;
    totalDeclaredSize += record.uncompressedSize;
    checkArchiveLimits(memberCount, totalDeclaredSize);
    offset = record.nextOffset;
  }

  if (offset !== cdEnd) {
    throw invalidZipArchive(
      "central directory records overrun the declared central directory size",
    );
  }
  if (memberCount !== entryCount) {
    throw invalidZipArchive(
      `central directory contains ${memberCount} member(s) but declares ${entryCount}`,
    );
  }
  assertCentralDirectoryTerminator(buf, cdEnd, eocdOffset);
  assertLocalFileHeadersTileArchive(buf, cdOffset, pairs);
  return { memberCount, totalDeclaredSize };
}

/**
 * Pre-inspects a ZIP archive's central directory to enforce extraction safety
 * constraints (#31). Fails closed: the directory is walked record by record and
 * rejected unless the walk terminates on a valid end record, matches the
 * declared member count and central directory size, and holds at least one member.
 */
export function inspectZipMembers(archivePath: string): {
  memberCount: number;
  totalDeclaredSize: number;
} {
  const buf = fs.readFileSync(archivePath);
  if (buf.length < ZIP_EOCD_MIN_SIZE) {
    throw invalidZipArchive("archive is too small to be a valid zip");
  }

  const eocdOffset = findEndOfCentralDirectory(buf);
  if (eocdOffset === -1) {
    throw invalidZipArchive("corrupt or invalid zip archive (missing EOCD)");
  }

  const location = resolveCentralDirectoryLocation(buf, eocdOffset);
  return walkCentralDirectory(buf, eocdOffset, location);
}

/** Detects whether an archive file starts with ZIP magic bytes. */
export function isZipArchive(archivePath: string): boolean {
  try {
    const fd = fs.openSync(archivePath, "r");
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (bytesRead < 4) return false;
    return (
      buf[0] === 0x50 &&
      buf[1] === 0x4b &&
      ((buf[2] === 0x03 && buf[3] === 0x04) ||
        (buf[2] === 0x05 && buf[3] === 0x06) ||
        (buf[2] === 0x07 && buf[3] === 0x08))
    );
  } catch {
    return false;
  }
}

/** Detects whether an archive file starts with GZIP magic bytes. */
export function isGzipArchive(archivePath: string): boolean {
  try {
    const fd = fs.openSync(archivePath, "r");
    const buf = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return bytesRead >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  } catch {
    return false;
  }
}

/** Pre-inspects archive members using tar listing or zip directory parsing to enforce extraction safety constraints (#31). */
export async function validateArchiveMembers(
  archivePath: string,
): Promise<{ memberCount: number; totalDeclaredSize: number }> {
  if (
    isZipArchive(archivePath) ||
    (archivePath.toLowerCase().endsWith(".zip") && !isGzipArchive(archivePath))
  ) {
    return inspectZipMembers(archivePath);
  }

  let memberCount = 0;
  let totalDeclaredSize = 0;
  const tarBin = getTarBinary();
  const archiveDir = path.dirname(archivePath);
  const archiveFile = path.basename(archivePath);

  try {
    const [namesOutput, verboseOutput] = await Promise.all([
      execFileAsync(tarBin, ["-tf", archiveFile], { cwd: archiveDir }),
      execFileAsync(tarBin, ["-tvf", archiveFile], { cwd: archiveDir }),
    ]);

    for (const rawName of namesOutput.stdout.split(/\r?\n/)) {
      const member = rawName.trim();
      if (!member) continue;
      memberCount++;
      checkEscapedMember(member);
    }

    for (const rawLine of verboseOutput.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^[lh]/.test(line) || line.includes(" -> ") || line.includes(" link to ")) {
        throw new LuaLSError(
          "Archive member is a symbolic or hard link. Refusing to extract archive-planted links.",
          "ERR_LUALS_EXTRACT",
          "Run 'nanos-lint clean-cache' and verify the LuaLS release integrity.",
        );
      }
      totalDeclaredSize += parseTarTvSize(line);
    }
    checkArchiveLimits(memberCount, totalDeclaredSize);
  } catch (err) {
    if (err instanceof LuaLSError) throw err;
    throw new LuaLSError(
      `Failed to inspect release archive before extraction: ${err instanceof Error ? err.message : String(err)}`,
      "ERR_LUALS_EXTRACT",
      "Run 'nanos-lint clean-cache' and ensure there is sufficient disk space.",
      { cause: err },
    );
  }

  return { memberCount, totalDeclaredSize };
}

/**
 * Minimum plausible size of a downloaded LuaLS executable. Release assets are
 * several megabytes, so anything smaller is a truncated download or a stray
 * file. This floor only applies to binaries nanos-lint fetched itself: a
 * user-supplied `LUALS_BIN` may legitimately be a small wrapper script.
 */
export const MIN_DOWNLOADED_BINARY_SIZE_BYTES = 100_000;

/**
 * Runs `binaryPath --version` and checks that it reports a LuaLS version.
 * Shared by every binary validation path; the size heuristic stays separate
 * because only downloaded archives have a known-plausible size.
 */
function reportsLuaLSVersion(binaryPath: string): boolean {
  try {
    const output = execFileSync(binaryPath, ["--version"], {
      timeout: 5000,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return /^\d+\.\d+\.\d+/.test(output.trim());
  } catch (err) {
    logger.debug(
      `[luals] Binary validation check failed for ${binaryPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Verifies that a downloaded or cached LuaLS binary exists, has non-trivial
 * size, and is executable.
 */
export function isBinaryValid(binaryPath: string): boolean {
  if (!fs.existsSync(binaryPath)) {
    return false;
  }
  try {
    const stats = fs.statSync(binaryPath);
    if (!stats.isFile() || stats.size < MIN_DOWNLOADED_BINARY_SIZE_BYTES) {
      return false;
    }
    return reportsLuaLSVersion(binaryPath);
  } catch (err) {
    logger.debug(
      `[luals] Binary validation check failed for ${binaryPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Verifies that an explicitly configured binary is a regular file that runs and
 * reports a LuaLS version, without the downloaded-archive size heuristic so
 * wrapper scripts (`LUALS_BIN=/usr/local/bin/lua-language-server`) keep working.
 */
export function isBinaryRunnable(binaryPath: string): boolean {
  try {
    if (!fs.statSync(binaryPath).isFile()) {
      return false;
    }
  } catch (err) {
    logger.debug(
      `[luals] Binary validation check failed for ${binaryPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  return reportsLuaLSVersion(binaryPath);
}

/**
 * Validates an explicitly configured LuaLS binary (`LUALS_BIN` environment
 * variable or `--luals-bin` CLI option) and returns its path.
 *
 * Both are documented escape hatches, so a typo, a stale path, a directory or an
 * unrelated executable must fail with an actionable error instead of a
 * confusing low-level failure deep inside the check run (#26). Executables are
 * accepted as-is when `--version` reports a version, including the thin wrapper
 * scripts that Homebrew/mason-style installations put on `PATH`: the size floor
 * used for downloaded archives would reject those.
 *
 * @param binaryPath Path exactly as the user supplied it.
 * @param source Name of the setting being validated (`LUALS_BIN` / `--luals-bin`).
 */
export function assertValidLuaLSBinary(binaryPath: string, source: string): string {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(binaryPath);
  } catch (err) {
    throw new LuaLSError(
      `${source} points to '${binaryPath}', which does not exist or cannot be read: ${err instanceof Error ? err.message : String(err)}`,
      "ERR_LUALS_BIN_INVALID",
      `Set ${source} to the full path of a lua-language-server executable, or leave it unset so nanos-lint resolves LuaLS automatically.`,
      { cause: err },
    );
  }

  if (!stats.isFile()) {
    throw new LuaLSError(
      `${source} points to '${binaryPath}', which is not a regular file (a directory or special file was found).`,
      "ERR_LUALS_BIN_INVALID",
      `Point ${source} at the lua-language-server executable itself, or leave it unset so nanos-lint resolves LuaLS automatically.`,
    );
  }

  if (!isBinaryRunnable(binaryPath)) {
    throw new LuaLSError(
      `${source} points to '${binaryPath}', which is not a runnable LuaLS binary (running it with '--version' failed or printed no version).`,
      "ERR_LUALS_BIN_INVALID",
      `Verify ${source} points at a working lua-language-server executable or wrapper script, or leave it unset so nanos-lint resolves LuaLS automatically.`,
    );
  }

  return binaryPath;
}
