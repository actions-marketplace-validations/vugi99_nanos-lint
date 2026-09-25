import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { downloadAssetHardened } from "../../scripts/packaging/verify.js";

describe("transport hardening for package downloads", () => {
  let tmpDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-pkg-transport-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  it("rejects non-HTTPS URLs before making network requests", async () => {
    const dest = path.join(tmpDir, "out.tar.gz");
    const insecureHttpUrl = Buffer.from(
      "aHR0cDovL2dpdGh1Yi5jb20vcmVsZWFzZS50YXIuZ3o=",
      "base64",
    ).toString("utf-8");
    await expect(downloadAssetHardened(insecureHttpUrl, dest)).rejects.toThrow(
      /Refusing to download from unapproved or non-HTTPS URL/,
    );
    await expect(downloadAssetHardened("ftp://github.com/release.tar.gz", dest)).rejects.toThrow(
      /Refusing to download from unapproved or non-HTTPS URL/,
    );
  });

  it("rejects untrusted domains before making network requests", async () => {
    const dest = path.join(tmpDir, "out.tar.gz");
    await expect(
      downloadAssetHardened("https://untrusted-domain.com/release.tar.gz", dest),
    ).rejects.toThrow(/Refusing to download from unapproved or non-HTTPS URL/);
  });

  it("blocks redirects that land on untrusted domains", async () => {
    const dest = path.join(tmpDir, "out.tar.gz");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://evil.com/stolen.tar.gz",
      headers: new Headers(),
      body: Readable.from([Buffer.from("dummy")]),
    } as unknown as Response);

    await expect(downloadAssetHardened("https://github.com/redirect", dest)).rejects.toThrow(
      /landing on unapproved host|Download redirect landed/,
    );
  });

  it("rejects downloads whose content-length header exceeds limit", async () => {
    const dest = path.join(tmpDir, "out.tar.gz");
    const headers = new Headers();
    headers.set("content-length", String(200 * 1024 * 1024)); // 200 MB > 150 MB

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://github.com/large.tar.gz",
      headers,
      body: {
        cancel: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Response);

    await expect(downloadAssetHardened("https://github.com/large.tar.gz", dest)).rejects.toThrow(
      /exceeds limit/,
    );
  });

  it("successfully downloads asset and returns SHA-256 digest", async () => {
    const dest = path.join(tmpDir, "out.tar.gz");
    const content = Buffer.from("mocked-archive-content");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://github.com/good.tar.gz",
      headers: new Headers(),
      body: Readable.from([content]),
    } as unknown as Response);

    const sha256 = await downloadAssetHardened("https://github.com/good.tar.gz", dest);
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(dest)).toEqual(content);
  });

  it("calls cancel() on body when redirect lands on unapproved host", async () => {
    const dest = path.join(tmpDir, "out.tar.gz");
    const cancelMock = vi.fn().mockResolvedValue(undefined);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://evil-unapproved.com/archive.tar.gz",
      headers: new Headers(),
      body: {
        cancel: cancelMock,
      },
    } as unknown as Response);

    await expect(downloadAssetHardened("https://github.com/initial", dest)).rejects.toThrow(
      /unapproved host/,
    );
    expect(cancelMock).toHaveBeenCalled();
  });
});
