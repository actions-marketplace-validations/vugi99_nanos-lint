import { logger } from "../logger.js";
import { LuaLSError } from "../errors.js";

export const FALLBACK_LUALS_VERSION = "3.19.1";
export const DEFAULT_LUALS_VERSION = "latest";

/** Characters accepted in a safe LuaLS version tag. */
const SAFE_VERSION_CHARS: ReadonlyMap<string, string> = new Map(
  [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._-"].map((ch) => [ch, ch]),
);

const MAX_VERSION_LENGTH = 64;

/**
 * Validates and normalizes a LuaLS version string to prevent path traversal or injection.
 * Drops a single leading 'v' and returns null on invalid characters.
 */
export function sanitizeLuaLSVersion(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) {
    return null;
  }

  let version = "";
  for (const ch of trimmed) {
    const allowed = SAFE_VERSION_CHARS.get(ch);
    if (allowed === undefined) {
      return null;
    }
    version += allowed;
  }

  // Drop a single leading "v" (e.g. "v3.19.1" -> "3.19.1").
  if (version.charCodeAt(0) === 0x76 /* "v" */) {
    version = version.slice(1);
  }

  // First character must be alphanumeric to prevent directory traversal or alias.
  const first = version.charCodeAt(0);
  const startsAlphanumeric =
    (first >= 0x30 && first <= 0x39) || // 0-9
    (first >= 0x41 && first <= 0x5a) || // A-Z
    (first >= 0x61 && first <= 0x7a); // a-z

  return startsAlphanumeric ? version : null;
}

/**
 * Fetches the latest available LuaLS release tag from the GitHub API.
 * Returns null if the request fails, times out, or receives an invalid tag.
 */
export async function fetchLatestLuaLSVersionFromGitHub(): Promise<string | null> {
  try {
    const headers: Record<string, string> = { "User-Agent": "nanos-lint" };
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(
      "https://api.github.com/repos/LuaLS/lua-language-server/releases/latest",
      {
        headers,
        signal: AbortSignal.timeout(5000),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      // The response body is untrusted input: only use it when it is a valid tag.
      const version =
        typeof data.tag_name === "string" ? sanitizeLuaLSVersion(data.tag_name) : null;
      if (version) {
        return version;
      }
    }
  } catch (err) {
    logger.debug(
      `[luals] Failed to resolve latest LuaLS version from GitHub API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

/**
 * Resolves the latest available LuaLS release tag from the GitHub API,
 * falling back to FALLBACK_LUALS_VERSION if offline or unreachable.
 */
export async function resolveLatestLuaLSVersion(): Promise<string> {
  const version = await fetchLatestLuaLSVersionFromGitHub();
  return version || FALLBACK_LUALS_VERSION;
}

/**
 * Resolves a version string ("latest" -> actual tag).
 *
 * @throws when an explicitly requested version is not a valid tag.
 */
export async function resolveLuaLSVersion(version?: string): Promise<string> {
  if (!version || version === "latest") {
    return await resolveLatestLuaLSVersion();
  }
  const sanitized = sanitizeLuaLSVersion(version);
  if (!sanitized) {
    throw new LuaLSError(
      `Invalid LuaLS version: "${version}". Expected a release tag such as "3.19.1", or "latest".`,
      "ERR_LUALS_INVALID_VERSION",
      "Provide a valid release tag like '3.19.1' or use 'latest'.",
    );
  }
  return sanitized;
}
