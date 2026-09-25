import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  validateArchiveMembers,
  MAX_DECOMPRESSED_SIZE_BYTES,
  getTarBinary,
  escapePowerShellSingleQuote,
} from "../../src/luals/validation.js";
import {
  isAllowedDownloadUrl,
  computeFileSha256,
  limitDownloadStream,
  MAX_ARCHIVE_SIZE_BYTES,
  DOWNLOAD_TIMEOUT_MS,
} from "../../src/luals/download.js";
import type { TargetArchitecture } from "./types.js";

const execFileAsync = promisify(execFile);

export function hasBinary(name: string): boolean {
  try {
    const checker = process.platform === "win32" ? "where" : "which";
    execFileSync(checker, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function canExtractZip(): boolean {
  return process.platform === "win32" || hasBinary("unzip");
}

export function inspectBinaryArch(buf: Buffer): string {
  if (buf.length > 20 && buf.readUInt32BE(0) === 0x7f454c46) {
    const machine = buf.readUInt16LE(18);
    return machine === 0xb7 ? "arm64" : machine === 0x3e ? "x64" : `elf-${machine}`;
  }
  if (buf.length > 8 && buf.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = buf.readUInt32LE(4);
    return cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : `macho-${cpu}`;
  }
  if (buf.length > 0x40 && buf.toString("ascii", 0, 2) === "MZ") {
    const peOffset = buf.readUInt32LE(0x3c);
    if (
      peOffset + 6 <= buf.length &&
      buf.toString("ascii", peOffset, peOffset + 4) === "PE\u0000\u0000"
    ) {
      const machine = buf.readUInt16LE(peOffset + 4);
      return machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : `pe-${machine}`;
    }
  }
  return "unknown";
}

export function verifyBinaryArch(binaryPath: string, expectedArch: TargetArchitecture): void {
  const buf = fs.readFileSync(binaryPath);
  const actual = inspectBinaryArch(buf);
  if (actual !== expectedArch) {
    throw new Error(
      `Binary architecture mismatch for ${binaryPath}: expected ${expectedArch} but detected ${actual}`,
    );
  }
}

export const DEFAULT_REQUIRED_LUALS_ENTRIES: readonly string[] = [
  "bin",
  "main.lua",
  "locale",
  "meta",
  "script",
];

export interface TreeInvariantOptions {
  expectedBinName: string;
  expectedArch: TargetArchitecture;
  maxTotalBytes?: number;
  requiredEntries?: readonly string[];
}

export function verifyExtractedTreeInvariants(
  extractedDir: string,
  options: TreeInvariantOptions,
): { totalBytes: number; fileCount: number } {
  if (!fs.existsSync(extractedDir) || !fs.statSync(extractedDir).isDirectory()) {
    throw new Error(`Extraction target is not an existing directory: ${extractedDir}`);
  }

  const canonicalRoot = fs.realpathSync(extractedDir);
  const maxBytes = options.maxTotalBytes ?? MAX_DECOMPRESSED_SIZE_BYTES;
  let totalBytes = 0;
  let fileCount = 0;

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, "utf-8");
    for (const entryName of entries) {
      const fullPath = path.join(currentDir, entryName);
      const lstat = fs.lstatSync(fullPath);

      if (lstat.isSymbolicLink()) {
        throw new Error(`Extracted tree invariant failed: symbolic link detected at ${fullPath}`);
      }

      const canonicalPath = fs.realpathSync(fullPath);
      if (!canonicalPath.startsWith(canonicalRoot + path.sep) && canonicalPath !== canonicalRoot) {
        throw new Error(
          `Extracted tree invariant failed: path escapes extraction root: ${canonicalPath}`,
        );
      }

      if (lstat.isDirectory()) {
        walk(fullPath);
      } else if (lstat.isFile()) {
        // Reject hard links (nlink > 1) as intentional defense against archive-planted links escaping or modifying files.
        if (lstat.nlink > 1) {
          throw new Error(
            `Extracted tree invariant failed: hard link detected at ${fullPath} (nlink=${lstat.nlink})`,
          );
        }
        totalBytes += lstat.size;
        fileCount++;
        if (totalBytes > maxBytes) {
          throw new Error(
            `Extracted tree invariant failed: total size ${totalBytes} exceeds limit ${maxBytes}`,
          );
        }
      } else {
        throw new Error(`Extracted tree invariant failed: special file detected at ${fullPath}`);
      }
    }
  }

  walk(extractedDir);

  const required = options.requiredEntries ?? DEFAULT_REQUIRED_LUALS_ENTRIES;
  for (const entry of required) {
    const fullEntryPath = path.join(extractedDir, entry);
    if (!fs.existsSync(fullEntryPath)) {
      throw new Error(
        `Extracted tree invariant failed: missing expected content set entry '${entry}' in ${extractedDir}`,
      );
    }
  }

  const mainLuaPath = path.join(extractedDir, "main.lua");
  if (!fs.statSync(mainLuaPath).isFile()) {
    throw new Error(`Extracted tree invariant failed: main.lua is not a file in ${extractedDir}`);
  }

  const binaryPath = path.join(extractedDir, "bin", options.expectedBinName);
  if (!fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) {
    throw new Error(`Extracted tree invariant failed: missing expected binary at ${binaryPath}`);
  }

  const binStat = fs.statSync(binaryPath);
  if (binStat.size < 100_000) {
    throw new Error(
      `Extracted tree invariant failed: binary ${binaryPath} is suspiciously small (${binStat.size} bytes)`,
    );
  }

  verifyBinaryArch(binaryPath, options.expectedArch);

  return { totalBytes, fileCount };
}

export async function downloadAssetHardened(url: string, destPath: string): Promise<string> {
  if (!isAllowedDownloadUrl(url)) {
    throw new Error(`Refusing to download from unapproved or non-HTTPS URL: ${url}`);
  }

  let response: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (res.url && !isAllowedDownloadUrl(res.url)) {
        if (typeof res.body?.cancel === "function") {
          await res.body.cancel().catch(() => {});
        }
        throw new Error(`Download redirect landed on unapproved host: ${res.url}`);
      }
      if (res.ok && res.body) {
        response = res;
        break;
      }
      if (typeof res.body?.cancel === "function") {
        await res.body.cancel().catch(() => {});
      }
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("Download redirect landed on unapproved host")
      ) {
        throw err;
      }
      lastErr = err;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  if (!response || !response.body) {
    throw new Error(
      `Failed to download ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  const lenHeader = response.headers?.get?.("content-length");
  if (lenHeader) {
    const len = parseInt(lenHeader, 10);
    if (!isNaN(len) && len > MAX_ARCHIVE_SIZE_BYTES) {
      if (typeof response.body.cancel === "function") {
        await response.body.cancel().catch(() => {});
      }
      throw new Error(`Archive size ${len} exceeds limit ${MAX_ARCHIVE_SIZE_BYTES}`);
    }
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const fileStream = fs.createWriteStream(destPath);
  const streamSource =
    typeof (Readable as unknown as { fromWeb?: (stream: unknown) => Readable }).fromWeb ===
      "function" && !("pipe" in response.body)
      ? Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
      : (response.body as unknown as Readable);

  await pipeline(streamSource, limitDownloadStream, fileStream);
  return computeFileSha256(destPath);
}

export async function safeExtractArchive(archivePath: string, targetDir: string): Promise<void> {
  await validateArchiveMembers(archivePath);

  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  const isZip = archivePath.toLowerCase().endsWith(".zip");

  if (process.platform === "win32") {
    if (isZip) {
      try {
        await execFileAsync(getTarBinary(), ["-xf", path.resolve(archivePath), "-C", targetDir]);
      } catch {
        await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${escapePowerShellSingleQuote(archivePath)}' -DestinationPath '${escapePowerShellSingleQuote(targetDir)}' -Force`,
        ]);
      }
    } else {
      await execFileAsync(getTarBinary(), ["-xf", path.resolve(archivePath), "-C", targetDir]);
    }
  } else {
    if (isZip) {
      if (!hasBinary("unzip")) {
        throw new Error(
          `Failed to extract zip archive '${archivePath}': 'unzip' utility is required on POSIX systems but was not found in PATH`,
        );
      }
      try {
        await execFileAsync("unzip", ["-q", "-o", path.resolve(archivePath), "-d", targetDir]);
      } catch (err) {
        throw new Error(
          `Failed to extract zip archive '${archivePath}' with unzip: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    } else {
      await execFileAsync("tar", [
        "-xf",
        path.resolve(archivePath),
        "--no-same-owner",
        "--no-same-permissions",
        "-C",
        targetDir,
      ]);
    }
  }
}
