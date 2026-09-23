import { logger } from "../logger.js";

export const FALLBACK_LUALS_VERSION = "3.19.1";
export const DEFAULT_LUALS_VERSION = "latest";

/**
 * Characters accepted in a LuaLS version/tag. Only ASCII letters, digits, dots,
 * dashes and underscores are allowed, so a version can never contain a path
 * separator, a drive letter or a traversal segment.
 */
const SAFE_VERSION_CHARS: ReadonlyMap<string, string> = new Map(
  [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._-"].map((ch) => [ch, ch])
);

const MAX_VERSION_LENGTH = 64;

/**
 * Validates a LuaLS version/tag and rebuilds it from the allow-list above.
 *
 * Version strings originate from untrusted sources: the GitHub releases API
 * response and user supplied `--luals-version` arguments. They are interpolated
 * into cache directory paths, download URLs, and the path of the binary that is
 * eventually executed, so they must be constrained to a single safe path
 * segment. Rebuilding the value character by character guarantees the returned
 * string only ever contains allow-listed characters (CodeQL: js/command-line-injection).
 *
 * @returns the normalized version (a single leading `v` is dropped), or `null`
 *          when the input cannot be used as a version tag.
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

  // The first character must be alphanumeric, which rejects "", "v", ".", ".."
  // and any other value that could escape or alias a directory as a path segment.
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
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      // The response body is untrusted input: only use it when it is a valid tag.
      const version = typeof data.tag_name === "string" ? sanitizeLuaLSVersion(data.tag_name) : null;
      if (version) {
        return version;
      }
    }
  } catch (err) {
    logger.debug(
      `[luals] Failed to resolve latest LuaLS version from GitHub API: ${err instanceof Error ? err.message : String(err)}`
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
    throw new Error(
      `Invalid LuaLS version: "${version}". Expected a release tag such as "3.19.1", or "latest".`
    );
  }
  return sanitized;
}

