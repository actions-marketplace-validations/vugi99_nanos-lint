import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ALLOWED_DOWNLOAD_DOMAINS,
  MAX_REDIRECT_HOPS,
  cancelResponseBody,
  guardedFetch,
  isAllowedDownloadUrl,
  parseDeclaredContentLength,
} from "../../src/download-guard.js";

/** A response double with a mutable `url`, mirroring the fields `guardedFetch()` reads. */
function fakeResponse(init: {
  status?: number;
  url?: string;
  location?: string | null;
  type?: string;
  /** Spy recorded as the response body's `cancel()`, so body release can be asserted. */
  cancel?: () => Promise<void>;
}): Response {
  const headers = new Headers();
  if (init.location !== null && init.location !== undefined) {
    headers.set("location", init.location);
  }
  return {
    status: init.status ?? 200,
    url: init.url ?? "",
    headers,
    type: init.type ?? "basic",
    body: { cancel: init.cancel ?? vi.fn().mockResolvedValue(undefined) },
  } as unknown as Response;
}

/** Installs a fetch double and returns the spy, so contacted URLs can be asserted. */
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn().mockImplementation((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(handler(url));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("download redirect guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("covers the documented GitHub infrastructure hosts only", () => {
    expect(ALLOWED_DOWNLOAD_DOMAINS).toEqual(["github.com", "githubusercontent.com"]);
    expect(MAX_REDIRECT_HOPS).toBeGreaterThan(0);
    expect(isAllowedDownloadUrl("https://github.com/LuaLS/lua-language-server/releases")).toBe(
      true,
    );
  });

  it("refuses a redirect to an off-allowlist host before contacting it", async () => {
    const target = "https://evil.example/annotations.lua";
    const contacted: string[] = [];
    const fetchSpy = stubFetch((url) => {
      contacted.push(url);
      return fakeResponse({ status: 302, location: target });
    });

    const result = await guardedFetch("https://raw.githubusercontent.com/nanos-world/annotations");

    expect(result).toMatchObject({ ok: false, reason: "disallowed-redirect", url: target });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(contacted).toEqual(["https://raw.githubusercontent.com/nanos-world/annotations"]);
    expect(contacted).not.toContain(target);
  });

  it("refuses a scheme-downgrading redirect to plaintext http://", async () => {
    const target = "http://raw.githubusercontent.com/nanos-world/annotations";
    const contacted: string[] = [];
    const fetchSpy = stubFetch((url) => {
      contacted.push(url);
      return fakeResponse({
        status: 301,
        location: "http://raw.githubusercontent.com/nanos-world/annotations",
      });
    });

    const result = await guardedFetch("https://raw.githubusercontent.com/nanos-world/annotations");

    expect(result).toMatchObject({ ok: false, reason: "disallowed-redirect", url: target });
    expect(contacted).toEqual(["https://raw.githubusercontent.com/nanos-world/annotations"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect aimed at an internal or link-local address", async () => {
    const target = "http://169.254.169.254/latest/meta-data/";
    const contacted: string[] = [];
    stubFetch((url) => {
      contacted.push(url);
      return fakeResponse({ status: 302, location: target });
    });

    const result = await guardedFetch("https://api.github.com/repos/x/y");

    expect(result).toMatchObject({ ok: false, reason: "disallowed-redirect", url: target });
    expect(contacted).toEqual(["https://api.github.com/repos/x/y"]);
  });

  it("follows allowlisted hops one at a time and returns the final response", async () => {
    const fetchSpy = stubFetch((url) =>
      url === "https://github.com/redirect-me"
        ? fakeResponse({ status: 302, location: "/LuaLS/lua-language-server/releases/latest" })
        : fakeResponse({ status: 200, url }),
    );

    const result = await guardedFetch("https://github.com/redirect-me");

    expect(result.ok).toBe(true);
    expect(result.response?.url).toBe(
      "https://github.com/LuaLS/lua-language-server/releases/latest",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual([
      "https://github.com/redirect-me",
      "https://github.com/LuaLS/lua-language-server/releases/latest",
    ]);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("stops after the maximum redirect hop budget", async () => {
    const contacted: string[] = [];
    stubFetch((url) => {
      contacted.push(url);
      return fakeResponse({ status: 302, location: `${url}/next` });
    });

    const result = await guardedFetch("https://github.com/hop-0");

    expect(result).toMatchObject({ ok: false, reason: "too-many-redirects" });
    expect(contacted).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });

  it("accepts a chain of exactly the maximum hop budget", async () => {
    const contacted: string[] = [];
    stubFetch((url) => {
      contacted.push(url);
      return contacted.length > MAX_REDIRECT_HOPS
        ? fakeResponse({ status: 200, url })
        : fakeResponse({ status: 302, location: `${url}/next` });
    });

    const result = await guardedFetch("https://github.com/hop-0");

    expect(result.ok).toBe(true);
    expect(contacted).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });

  it("refuses a protocol-relative Location that points off-allowlist", async () => {
    const contacted: string[] = [];
    stubFetch((url) => {
      contacted.push(url);
      return fakeResponse({ status: 302, location: "//evil.example/annotations.lua" });
    });

    const result = await guardedFetch("https://raw.githubusercontent.com/nanos-world/annotations");

    expect(result).toMatchObject({
      ok: false,
      reason: "disallowed-redirect",
      url: "https://evil.example/annotations.lua",
    });
    expect(contacted).toHaveLength(1);
  });

  it("refuses an empty Location header instead of re-requesting the same URL", async () => {
    const contacted: string[] = [];
    const cancel = vi.fn().mockResolvedValue(undefined);
    stubFetch((url) => {
      contacted.push(url);
      return fakeResponse({ status: 302, location: "", cancel });
    });

    const result = await guardedFetch("https://github.com/loop");

    expect(result).toMatchObject({ ok: false, reason: "missing-location" });
    expect(contacted).toHaveLength(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("releases the body of every refused response", async () => {
    const redirectCancel = vi.fn().mockResolvedValue(undefined);
    stubFetch(() =>
      fakeResponse({ status: 302, location: "https://evil.example/x", cancel: redirectCancel }),
    );
    const redirectResult = await guardedFetch("https://github.com/redirected");
    expect(redirectResult.ok).toBe(false);
    expect(redirectCancel).toHaveBeenCalledTimes(1);

    const finalCancel = vi.fn().mockResolvedValue(undefined);
    stubFetch(() =>
      fakeResponse({ status: 200, url: "https://evil.example/x", cancel: finalCancel }),
    );
    const finalResult = await guardedFetch("https://github.com/final");
    expect(finalResult.ok).toBe(false);
    expect(finalCancel).toHaveBeenCalledTimes(1);

    const opaqueCancel = vi.fn().mockResolvedValue(undefined);
    stubFetch(() => fakeResponse({ status: 0, type: "opaqueredirect", cancel: opaqueCancel }));
    const opaqueResult = await guardedFetch("https://github.com/opaque-body");
    expect(opaqueResult.ok).toBe(false);
    expect(opaqueCancel).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect response that carries no Location header", async () => {
    stubFetch(() => fakeResponse({ status: 302, location: null }));

    const result = await guardedFetch("https://github.com/no-location");

    expect(result).toMatchObject({ ok: false, reason: "missing-location" });
  });

  it("refuses a 3xx response that cannot expose headers at all", async () => {
    stubFetch(() => ({ status: 302, url: "https://github.com/opaque" }) as unknown as Response);

    const result = await guardedFetch("https://github.com/opaque");

    expect(result).toMatchObject({ ok: false, reason: "missing-location" });
  });

  it("refuses a redirect whose Location header is unusable", async () => {
    stubFetch(() => fakeResponse({ status: 302, location: "file:///etc/passwd" }));

    const result = await guardedFetch("https://github.com/broken-location");

    expect(result).toMatchObject({
      ok: false,
      reason: "disallowed-redirect",
      url: "file:///etc/passwd",
    });
  });

  it("refuses a Location header that cannot be parsed relative to the request URL", async () => {
    stubFetch(() => fakeResponse({ status: 302, location: "https://[not-ipv6]/x" }));

    const result = await guardedFetch("https://github.com/malformed-location");

    expect(result).toMatchObject({
      ok: false,
      reason: "disallowed-redirect",
      url: "https://[not-ipv6]/x",
    });
  });

  it("blocks a response the runtime followed into an opaque cross-origin redirect", async () => {
    stubFetch(() => fakeResponse({ status: 0, type: "opaqueredirect", url: "" }));

    const result = await guardedFetch("https://github.com/opaque");

    expect(result).toMatchObject({ ok: false, reason: "disallowed-redirect" });
  });

  it("blocks a 2xx response whose own URL left the allowlist", async () => {
    stubFetch(() => fakeResponse({ status: 200, url: "https://evil.example/annotations.lua" }));

    const result = await guardedFetch("https://raw.githubusercontent.com/nanos-world/annotations");

    expect(result).toMatchObject({
      ok: false,
      reason: "disallowed-redirect",
      url: "https://evil.example/annotations.lua",
    });
  });

  it("refuses a request whose own URL is off-allowlist without contacting it", async () => {
    const fetchSpy = stubFetch(() => fakeResponse({ status: 200 }));

    const result = await guardedFetch("http://internal.corp/annotations.lua");

    expect(result).toMatchObject({ ok: false, reason: "disallowed-url" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports transport failures as network errors", async () => {
    const failure = new Error("ECONNREFUSED");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));

    const result = await guardedFetch("https://api.github.com/repos/x/y");

    expect(result).toMatchObject({ ok: false, reason: "network-error", error: failure });
  });

  it("returns a direct allowlisted response untouched", async () => {
    stubFetch((url) => fakeResponse({ status: 200, url }));

    const result = await guardedFetch("https://api.github.com/repos/x/y", {
      headers: { "User-Agent": "nanos-lint" },
    });

    expect(result.ok).toBe(true);
    expect(result.response?.status).toBe(200);
  });

  it("cancels response bodies tolerantly, including doubles without a body", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    await cancelResponseBody({ body: { cancel } } as unknown as Response);
    expect(cancel).toHaveBeenCalledTimes(1);

    const rejected = vi.fn().mockRejectedValue(new Error("already consumed"));
    await expect(
      cancelResponseBody({ body: { cancel: rejected } } as unknown as Response),
    ).resolves.toBeUndefined();

    await expect(cancelResponseBody({} as unknown as Response)).resolves.toBeUndefined();
  });
});

describe("allowlist boundaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts GitHub hosts and their subdomains over HTTPS", () => {
    for (const url of [
      "https://github.com/LuaLS/lua-language-server/releases",
      "https://api.github.com/repos/x/y",
      "https://raw.githubusercontent.com/nanos-world/x/annotations.lua",
      "https://objects.githubusercontent.com/asset.tar.gz",
      "https://release-assets.githubusercontent.com/asset.zip",
      "https://gist.github.com/x",
      "https://a.b.github.com/x",
      "https://githubusercontent.com/x",
      "https://GITHUB.COM/x",
      "https://github.com:8443/x",
    ]) {
      expect(isAllowedDownloadUrl(url), url).toBe(true);
    }
  });

  it("refuses look-alike hosts that merely contain an allowlisted domain", () => {
    for (const url of [
      "https://evilgithub.com/x",
      "https://notgithub.com/x",
      "https://xgithub.com/x",
      "https://github.com.evil.com/x",
      "https://raw.githubusercontent.com.evil.com/x",
      "https://githubusercontent.com.evil.com/x",
      "https://evilgithubusercontent.com/x",
      "https://github.com./x",
      "https://github.com@evil.com/x",
    ]) {
      expect(isAllowedDownloadUrl(url), url).toBe(false);
    }
  });

  it("refuses non-HTTPS schemes, IP literals and non-host targets", () => {
    for (const url of [
      "http://github.com/x",
      "ftp://github.com/x",
      "data:text/plain,hello",
      "file:///etc/passwd",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/x",
      "https://[::ffff:169.254.169.254]/x",
      "//github.com/x",
      "",
      "not-a-url",
    ]) {
      expect(isAllowedDownloadUrl(url), url).toBe(false);
    }
  });

  it("refuses a link-local redirect target even when the scheme is HTTPS", async () => {
    const contacted: string[] = [];
    stubFetch((url) => {
      contacted.push(url);
      return fakeResponse({
        status: 302,
        location: "https://169.254.169.254/latest/meta-data/",
      });
    });

    const result = await guardedFetch("https://api.github.com/repos/x/y");

    expect(result).toMatchObject({
      ok: false,
      reason: "disallowed-redirect",
      url: "https://169.254.169.254/latest/meta-data/",
    });
    expect(contacted).toEqual(["https://api.github.com/repos/x/y"]);
  });
});

describe("credentials across redirect hops", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs a one-hop redirect from `from` to `to`, returning the `init` of every request. */
  async function hopInits(from: string, to: string): Promise<RequestInit[]> {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string, init: RequestInit) => {
        inits.push(init);
        const url = String(input);
        return Promise.resolve(
          url === from
            ? fakeResponse({ status: 302, location: to })
            : fakeResponse({ status: 200, url }),
        );
      }),
    );
    await guardedFetch(from, {
      headers: { "User-Agent": "nanos-lint", Authorization: "token SECRET" },
    });
    return inits;
  }

  it("drops credentials on a hop to another allowlisted origin", async () => {
    const inits = await hopInits(
      "https://api.github.com/repos/x/y",
      "https://objects.githubusercontent.com/asset",
    );

    expect(inits).toHaveLength(2);
    expect(new Headers(inits[0]?.headers).get("authorization")).toBe("token SECRET");
    expect(new Headers(inits[1]?.headers).get("authorization")).toBeNull();
    expect(new Headers(inits[1]?.headers).get("user-agent")).toBe("nanos-lint");
  });

  it("keeps credentials on a same-origin hop", async () => {
    const inits = await hopInits("https://api.github.com/repos/x/y", "/repos/x/y/next");

    expect(inits).toHaveLength(2);
    expect(new Headers(inits[1]?.headers).get("authorization")).toBe("token SECRET");
  });
});

describe("declared content length (#50)", () => {
  const withHeaders = (init: Record<string, string>): Response =>
    ({ headers: new Headers(init) }) as unknown as Response;

  it("reads a positive content-length of an uncompressed response", () => {
    expect(parseDeclaredContentLength(withHeaders({ "content-length": "3600" }))).toBe(3600);
    expect(
      parseDeclaredContentLength(
        withHeaders({ "content-encoding": "IDENTITY ", "content-length": "12" }),
      ),
    ).toBe(12);
  });

  it("ignores the compressed length of a content-encoded response", () => {
    expect(
      parseDeclaredContentLength(
        withHeaders({ "content-encoding": "gzip", "content-length": "108241" }),
      ),
    ).toBe(undefined);
    expect(
      parseDeclaredContentLength(withHeaders({ "content-encoding": "br", "content-length": "10" })),
    ).toBe(undefined);
  });

  it("ignores missing, malformed and non-positive lengths", () => {
    expect(parseDeclaredContentLength(withHeaders({}))).toBe(undefined);
    expect(parseDeclaredContentLength(withHeaders({ "content-length": "chunked" }))).toBe(
      undefined,
    );
    expect(parseDeclaredContentLength(withHeaders({ "content-length": "0" }))).toBe(undefined);
    expect(parseDeclaredContentLength(withHeaders({ "content-length": "-5" }))).toBe(undefined);
    expect(parseDeclaredContentLength({} as unknown as Response)).toBe(undefined);
  });
});
