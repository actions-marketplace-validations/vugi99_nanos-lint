import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { AnnotationsError } from "./errors.js";
import { withFileLock, writeAtomicFile } from "./lock.js";
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
): Promise<string | null> {
  const lengthHeader = res.headers?.get?.("content-length");
  if (lengthHeader) {
    const declared = parseInt(lengthHeader, 10);
    if (!isNaN(declared) && declared > maxBytes) {
      if (typeof res.body?.cancel === "function") {
        await res.body.cancel().catch(() => {});
      }
      onExceeded(declared, "header");
      return null;
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
        return null;
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
      return null;
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
      const rawJson = await readBoundedResponseBody(res, MAX_COMMIT_JSON_SIZE_BYTES, (bytes) => {
        logger.warn(
          `GitHub commits response exceeded size limit of ${MAX_COMMIT_JSON_SIZE_BYTES} bytes (${bytes} bytes)`,
        );
      });
      if (rawJson === null) {
        return null;
      }
      if (!rawJson && !res.bodyUsed && typeof res.json === "function") {
        const data = (await res.json()) as { sha?: string };
        if (typeof data.sha === "string" && /^[0-9a-fA-F]{7,40}$/.test(data.sha)) {
          return data.sha;
        }
        return null;
      }
      if (!rawJson) {
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

/**
 * Downloads annotations.lua and writes it with its metadata inside an exclusive cache
 * lock (`.annotations.lock`). The completion check is repeated once the lock is held, so
 * parallel callers reuse the file a concurrent worker just wrote instead of racing on
 * the same paths, and both files are replaced atomically (#7).
 */
export async function downloadAndCacheAnnotations(
  commitId: string,
  cacheDir: string = getAnnotationsCacheDir(),
): Promise<string> {
  fs.mkdirSync(cacheDir, { recursive: true });

  const finalAnnotationsPath = path.join(cacheDir, ANNOTATIONS_FILENAME);
  const finalMetaPath = path.join(cacheDir, METADATA_FILENAME);
  const lockPath = path.join(cacheDir, ".annotations.lock");

  return withFileLock(
    lockPath,
    async () => {
      const existingMeta = readAnnotationsMetadata(cacheDir);
      if (
        existingMeta &&
        existingMeta.commitId === commitId &&
        fs.existsSync(finalAnnotationsPath) &&
        isAnnotationsValid(finalAnnotationsPath)
      ) {
        logger.debug(`[annotations] Reusing cached annotations for commit ${commitId}.`);
        return finalAnnotationsPath;
      }

      const label = commitId && commitId !== "unknown" ? ` (${commitId.slice(0, 7)})` : "";
      logger.info(`[annotations] Downloading nanos world API annotations${label}...`);
      const content = await fetchRawAnnotationsContent(commitId);
      const { dateStr, dateObj } = getTodayDateString();
      const metadata: AnnotationsMetadata = { commitId, lastChecked: dateStr, date: dateObj };

      // Atomic replacement keeps readers on either the previous or the new complete
      // file. The metadata is written last, so an interrupted update is retried later.
      await writeAtomicFile(finalAnnotationsPath, content);
      await writeAtomicFile(finalMetaPath, JSON.stringify(metadata, null, 2));

      const commitLabel =
        commitId && commitId !== "unknown" ? ` to commit ${commitId.slice(0, 7)}` : "";
      logger.info(`[annotations] Updated annotations.lua${commitLabel}.`);
      return finalAnnotationsPath;
    },
    { label: "annotations" },
  );
}
