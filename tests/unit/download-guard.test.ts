import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ALLOWED_DOWNLOAD_DOMAINS,
  MAX_REDIRECT_HOPS,
  cancelResponseBody,
  guardedFetch,
  isAllowedDownloadUrl,
} from "../../src/download-guard.js";

/** A response double with a mutable `url`, mirroring the fields `guardedFetch()` reads. */
function fakeResponse(init: {
  status?: number;
  url?: string;
  location?: string | null;
  type?: string;
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
    body: { cancel: vi.fn().mockResolvedValue(undefined) },
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
