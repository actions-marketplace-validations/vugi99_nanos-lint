import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "./logger.js";
import { AnnotationsError } from "./errors.js";
import {
  ANNOTATIONS_FILENAME,
  METADATA_FILENAME,
  MIN_ANNOTATIONS_SIZE_BYTES,
  MAX_ANNOTATIONS_SIZE_BYTES,
  MAX_COMMIT_JSON_SIZE_BYTES,
  type AnnotationsMetadata,
  getAnnotationsCacheDir,
  getTodayDateString,
  isAnnotationsValid,
  readAnnotationsMetadata,
} from "./annotations-metadata.js";

export const DOCGEN_REPO = "nanos-world/vscode-extension";
export const DOCGEN_BRANCH = "docgen-output";
export const RAW_ANNOTATIONS_URL =
  "https://raw.githubusercontent.com/nanos-world/vscode-extension/refs/heads/docgen-output/annotations.lua";
export const GITHUB_COMMITS_API =
  "https://api.github.com/repos/nanos-world/vscode-extension/commits/docgen-output";

/** Reads an HTTP response body with an upper byte limit to guard against memory exhaustion. */
async function readBoundedResponseBody(
  res: Response,
  maxBytes: number,
  onExceeded: (bytes: number, reason: "header" | "stream") => never | void,
): Promise<string> {
  const lengthHeader = res.headers?.get?.("content-length");
  if (lengthHeader) {
    const declared = parseInt(lengthHeader, 10);
    if (!isNaN(declared) && declared > maxBytes) {
      if (typeof res.body?.cancel === "function") {
        await res.body.cancel().catch(() => {});
      }
      onExceeded(declared, "header");
      return "";
    }
  }

  if (
    res.body &&
    typeof (res.body as unknown as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function"
  ) {
    let total = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of res.body as AsyncIterable<Uint8Array | Buffer>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        if (typeof res.body.cancel === "function") {
          await res.body.cancel().catch(() => {});
        }
        onExceeded(total, "stream");
        return "";
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  if (typeof res.text === "function") {
    const text = await res.text();
    const len = Buffer.byteLength(text, "utf-8");
    if (len > maxBytes) {
      onExceeded(len, "stream");
      return "";
    }
    return text;
  }

  return "";
}

/** Fetches the latest commit SHA for the annotations branch from the GitHub API. */
export async function fetchLatestCommitId(): Promise<string | null> {
  try {
    const headers: Record<string, string> = { "User-Agent": "nanos-lint" };
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(GITHUB_COMMITS_API, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      let exceeded = false;
      const rawJson = await readBoundedResponseBody(res, MAX_COMMIT_JSON_SIZE_BYTES, (bytes) => {
        exceeded = true;
        logger.warn(
          `GitHub commits response exceeded size limit of ${MAX_COMMIT_JSON_SIZE_BYTES} bytes (${bytes} bytes)`,
        );
      });
      if (exceeded) return null;
      if (!rawJson && typeof res.json === "function") {
        const data = (await res.json()) as { sha?: string };
        if (typeof data.sha === "string" && /^[0-9a-fA-F]{7,40}$/.test(data.sha)) {
          return data.sha;
        }
        return null;
      }
      const data = JSON.parse(rawJson) as { sha?: string };
      if (typeof data.sha === "string" && /^[0-9a-fA-F]{7,40}$/.test(data.sha)) {
        return data.sha;
      }
    }
  } catch (err) {
    logger.warn(
      `Failed to resolve latest annotations commit from GitHub: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

/** Returns raw annotations URL, pinned to commit SHA if provided and valid. */
export function getRawAnnotationsUrl(commitSha?: string): string {
  if (commitSha && /^[0-9a-fA-F]{7,40}$/.test(commitSha)) {
    return `https://raw.githubusercontent.com/${DOCGEN_REPO}/${commitSha}/annotations.lua`;
  }
  return RAW_ANNOTATIONS_URL;
}

/** Downloads raw annotations.lua content from GitHub raw content endpoints. */
export async function fetchRawAnnotationsContent(commitSha?: string): Promise<string> {
  const url = getRawAnnotationsUrl(commitSha);
  const res = await fetch(url, {
    headers: { "User-Agent": "nanos-lint" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new AnnotationsError(
      `Failed to download annotations.lua: ${res.status} ${res.statusText}`,
      "ERR_ANNOTATIONS_DOWNLOAD",
      "Verify your internet connection and that GitHub raw endpoints are accessible.",
    );
  }

  const text = await readBoundedResponseBody(res, MAX_ANNOTATIONS_SIZE_BYTES, (bytes, reason) => {
    const msg =
      reason === "header"
        ? `Annotations file size (${bytes} bytes) exceeds maximum limit (${MAX_ANNOTATIONS_SIZE_BYTES} bytes)`
        : `Annotations file download exceeded maximum allowed size of ${MAX_ANNOTATIONS_SIZE_BYTES} bytes`;
    throw new AnnotationsError(
      msg,
      "ERR_ANNOTATIONS_TOO_LARGE",
      "Specify a local annotations file via --annotations <path>.",
    );
  });

  if (!text || text.length < MIN_ANNOTATIONS_SIZE_BYTES) {
    throw new AnnotationsError(
      "Downloaded annotations.lua appears truncated or invalid",
      "ERR_ANNOTATIONS_INVALID",
      "Retry downloading or pass a local annotations file via --annotations <path>.",
    );
  }
  return text;
}

/** Copies a file with exponential backoff retries to handle transient file lock contention. */
async function copyFileWithRetry(src: string, dest: string, maxRetries = 10): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.copyFileSync(src, dest);
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/** Downloads annotations.lua and writes metadata in a chained atomic transaction with rollback. */
export async function downloadAndCacheAnnotations(
  commitId: string,
  cacheDir: string = getAnnotationsCacheDir(),
  options?: { quiet?: boolean },
): Promise<string> {
  fs.mkdirSync(cacheDir, { recursive: true });

  const finalAnnotationsPath = path.join(cacheDir, ANNOTATIONS_FILENAME);
  const finalMetaPath = path.join(cacheDir, METADATA_FILENAME);
  const tempDir = path.join(
    os.tmpdir(),
    `nanos-ann-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const backupDir = path.join(
    os.tmpdir(),
    `nanos-ann-bak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let hasBackup = false;

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    if (!options?.quiet) {
      const label = commitId && commitId !== "unknown" ? ` (${commitId.slice(0, 7)})` : "";
      logger.info(`[annotations] Downloading nanos world API annotations${label}...`);
    }

    const content = await fetchRawAnnotationsContent(commitId);
    const tempAnnotationsPath = path.join(tempDir, ANNOTATIONS_FILENAME);
    fs.writeFileSync(tempAnnotationsPath, content, "utf-8");

    const { dateStr, dateObj } = getTodayDateString();
    const metadata: AnnotationsMetadata = { commitId, lastChecked: dateStr, date: dateObj };
    const tempMetaPath = path.join(tempDir, METADATA_FILENAME);
    fs.writeFileSync(tempMetaPath, JSON.stringify(metadata, null, 2), "utf-8");

    const existingMeta = readAnnotationsMetadata(cacheDir);
    if (
      existingMeta &&
      existingMeta.commitId === commitId &&
      fs.existsSync(finalAnnotationsPath) &&
      isAnnotationsValid(finalAnnotationsPath)
    ) {
      return finalAnnotationsPath;
    }

    const oldAnnotationsExists = fs.existsSync(finalAnnotationsPath);
    const oldMetaExists = fs.existsSync(finalMetaPath);
    if (oldAnnotationsExists || oldMetaExists) {
      fs.mkdirSync(backupDir, { recursive: true });
      if (oldAnnotationsExists) {
        await copyFileWithRetry(finalAnnotationsPath, path.join(backupDir, ANNOTATIONS_FILENAME));
      }
      if (oldMetaExists) {
        await copyFileWithRetry(finalMetaPath, path.join(backupDir, METADATA_FILENAME));
      }
      hasBackup = true;
    }

    await copyFileWithRetry(tempAnnotationsPath, finalAnnotationsPath);
    await copyFileWithRetry(tempMetaPath, finalMetaPath);

    if (!options?.quiet) {
      const label = commitId && commitId !== "unknown" ? ` to commit ${commitId.slice(0, 7)}` : "";
      logger.info(`[annotations] Updated annotations.lua${label}.`);
    }
    return finalAnnotationsPath;
  } catch (err) {
    if (hasBackup && fs.existsSync(backupDir)) {
      try {
        const bAnn = path.join(backupDir, ANNOTATIONS_FILENAME);
        const bMeta = path.join(backupDir, METADATA_FILENAME);
        if (fs.existsSync(bAnn)) await copyFileWithRetry(bAnn, finalAnnotationsPath);
        if (fs.existsSync(bMeta)) await copyFileWithRetry(bMeta, finalMetaPath);
      } catch (rollbackErr) {
        logger.error(
          `Failed to restore annotations from backup during rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        );
      }
    }
    throw err;
  } finally {
    try {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `Failed to clean up annotations temporary or backup directory: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
