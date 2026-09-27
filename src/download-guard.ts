/**
 * Shared transport policy for every outbound download performed by nanos-lint.
 *
 * `SECURITY.md` requires download requests *and* HTTP redirects to use HTTPS and to stay on
 * GitHub infrastructure. Redirects are therefore resolved hop by hop in `"manual"` mode: the
 * default `"follow"` mode contacts the redirect target before any check can run, which would
 * let a redirect downgrade to plaintext `http://` or reach an internal address.
 */

export const ALLOWED_DOWNLOAD_DOMAINS: readonly string[] = ["github.com", "githubusercontent.com"];

/** Maximum number of redirect hops followed before a request is refused. */
export const MAX_REDIRECT_HOPS = 5;

/** Headers that must never follow a redirect to another origin. */
const CREDENTIAL_HEADERS: readonly string[] = ["authorization", "cookie", "proxy-authorization"];

/** Returns the origin of an already validated URL, or null when it cannot be parsed. */
function originOf(urlString: string): string | null {
  try {
    return new URL(urlString).origin;
  } catch {
    return null;
  }
}

/**
 * Returns the caller's headers with credentials removed.
 *
 * The runtime strips `Authorization` when it follows a redirect by itself, so dropping it here
 * keeps that guarantee once the guard re-issues each hop manually instead of following it.
 */
function withoutCredentialHeaders(headers: RequestInit["headers"]): RequestInit["headers"] {
  if (headers === undefined) {
    return undefined;
  }
  const stripped = new Headers(headers);
  for (const name of CREDENTIAL_HEADERS) {
    stripped.delete(name);
  }
  return stripped;
}

/** Validates that a URL uses HTTPS and targets an allowlisted GitHub host. */
export function isAllowedDownloadUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_DOWNLOAD_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

/** Why an outbound request was refused before or during its redirect chain. */
export type DownloadBlockReason =
  | "disallowed-url"
  | "disallowed-redirect"
  | "missing-location"
  | "network-error"
  | "too-many-redirects";

export interface GuardedFetchResult {
  ok: boolean;
  /** Final response; present only when the request was allowed end to end. */
  response?: Response;
  reason?: DownloadBlockReason;
  /** URL of the refused hop (the redirect target when a redirect was refused). */
  url?: string;
  /** Present when the transport failed before any response was received. */
  error?: unknown;
}

/**
 * Releases a response body without letting cleanup failures mask the block reason.
 *
 * Every failure mode is swallowed on purpose: a missing body, a double that exposes no
 * `cancel()`, and a `cancel()` that rejects or returns a non-promise must all leave the
 * caller free to report why the response was refused.
 */
export async function cancelResponseBody(res: Response): Promise<void> {
  try {
    if (typeof res.body?.cancel === "function") {
      await res.body.cancel();
    }
  } catch (err) {
    // Cleanup is best-effort: the refusal reason is the actionable information.
    void err;
  }
}

/** Reads the `Location` header of a redirect response, tolerating minimal test doubles. */
function getRedirectLocation(res: Response): string | null {
  if (typeof res.headers?.get !== "function") {
    return null;
  }
  return res.headers.get("location");
}

/**
 * Reads the `content-length` of a response whose bytes are streamed as received.
 *
 * A content-encoded response (`content-encoding: gzip`, `br`, ...) is decoded by the runtime
 * while its `content-length` still counts the compressed payload, so that value describes
 * neither the byte stream a progress bar counts nor the text that reaches the cache. Such a
 * response reports no usable length and progress falls back to transferred bytes and speed.
 */
export function parseDeclaredContentLength(res: Response): number | undefined {
  const encoding = (res.headers?.get?.("content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity") {
    return undefined;
  }
  const header = res.headers?.get?.("content-length");
  if (!header) {
    return undefined;
  }
  const declared = parseInt(header, 10);
  return Number.isFinite(declared) && declared > 0 ? declared : undefined;
}

/** Classifies a response the runtime followed by itself despite `redirect: "manual"`. */
function isOpaqueRedirect(res: Response): boolean {
  return res.type === "opaqueredirect";
}

/**
 * Performs a fetch with hop-by-hop redirect validation against the allowlist.
 *
 * Each hop must use HTTPS and stay on an allowlisted GitHub host; a hop that does not is never
 * contacted, because `redirect: "manual"` surfaces the 3xx response instead of following it.
 * The final response URL is validated as well, which keeps the policy enforced even on a
 * runtime that ignores `"manual"` and follows redirects on its own.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit = {},
): Promise<GuardedFetchResult> {
  if (!isAllowedDownloadUrl(url)) {
    return { ok: false, reason: "disallowed-url", url };
  }

  let currentUrl = url;
  let currentInit = init;
  let followed = 0;
  const requestOrigin = originOf(url);

  for (;;) {
    let response: Response;
    try {
      response = await fetch(currentUrl, { ...currentInit, redirect: "manual" });
    } catch (err) {
      return { ok: false, reason: "network-error", url: currentUrl, error: err };
    }

    if (isOpaqueRedirect(response)) {
      await cancelResponseBody(response);
      return { ok: false, reason: "disallowed-redirect", url: currentUrl };
    }

    const isRedirect = response.status >= 300 && response.status < 400;

    if (!isRedirect) {
      // A non-redirect response should still be the URL that was requested. Checking it keeps
      // the policy enforced if the runtime followed a redirect despite `"manual"`.
      if (response.url && !isAllowedDownloadUrl(response.url)) {
        await cancelResponseBody(response);
        return { ok: false, reason: "disallowed-redirect", url: response.url };
      }
      return { ok: true, response };
    }

    // A 3xx without a usable target is never accepted as a final response. A blank `Location`
    // would otherwise resolve to the current URL and spin until the hop budget runs out.
    const location = getRedirectLocation(response);
    if (location === null || location.trim() === "") {
      await cancelResponseBody(response);
      return { ok: false, reason: "missing-location", url: currentUrl };
    }

    // The redirect target is validated before it is ever requested.
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch (err) {
      void err;
      nextUrl = "";
    }
    if (!isAllowedDownloadUrl(nextUrl)) {
      await cancelResponseBody(response);
      return { ok: false, reason: "disallowed-redirect", url: nextUrl || location };
    }

    await cancelResponseBody(response);
    followed++;
    if (followed > MAX_REDIRECT_HOPS) {
      return { ok: false, reason: "too-many-redirects", url: nextUrl };
    }
    // The hop target is trusted, but a credential minted for the original host is not:
    // mirror the runtime's own cross-origin credential stripping.
    const nextOrigin = originOf(nextUrl);
    if (requestOrigin !== null && nextOrigin !== null && nextOrigin !== requestOrigin) {
      currentInit = { ...init, headers: withoutCredentialHeaders(init.headers) };
    }
    currentUrl = nextUrl;
  }
}
