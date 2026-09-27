import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { downloadAndExtractLuaLS } from "../../src/luals.js";
import { logger } from "../../src/logger.js";

/**
 * The LuaLS release archive is the one outbound request that always redirects upstream
 * (`github.com` -> `release-assets.githubusercontent.com`), so these tests pin the transport
 * that refuses an unapproved hop *before* it can be contacted (GHSA-m37q-x7fv-322c, Issue #19).
 */
describe("LuaLS archive redirect guard", () => {
  it("rejects untrusted redirect URLs without retrying (Issue #19)", async () => {
    const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-redirect-test-"));
    const originalFetch = globalThis.fetch;
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const cancelFn = vi.fn();
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({
        ok: true,
        url: "https://evil-mirror.com/asset.tar.gz",
        body: { cancel: cancelFn },
      } as unknown as Response);
    });
    try {
      await expect(
        downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
      ).rejects.toMatchObject({
        name: "LuaLSError",
        code: "ERR_LUALS_DOWNLOAD",
        remedy: "Download redirects must stay on allowlisted HTTPS GitHub hosts.",
        message: expect.stringContaining(
          "Redirect to untrusted URL blocked: https://evil-mirror.com/asset.tar.gz",
        ),
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(cancelFn).toHaveBeenCalledTimes(1);
      // This is the request that always redirects upstream, so its transport mode is the
      // guarantee that an unapproved hop is validated *before* it is contacted.
      expect(capturedInit).toMatchObject({ redirect: "manual" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Redirect to untrusted URL blocked: https://evil-mirror.com/asset.tar.gz",
        ),
      );
    } finally {
      warnSpy.mockRestore();
      globalThis.fetch = originalFetch;
      fs.rmSync(tempTarget, { recursive: true, force: true });
    }
  });

  it("never contacts an off-allowlist redirect hop during the archive download", async () => {
    const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-redirect-hop-"));
    const originalFetch = globalThis.fetch;
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const contacted: string[] = [];
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      contacted.push(String(url));
      return Promise.resolve({
        status: 302,
        url: String(url),
        headers: new Headers({ location: "http://169.254.169.254/asset.tar.gz" }),
        body: { cancel: cancelFn },
      } as unknown as Response);
    });
    try {
      await expect(
        downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
      ).rejects.toMatchObject({
        code: "ERR_LUALS_DOWNLOAD",
        message: expect.stringContaining(
          "Redirect to untrusted URL blocked: http://169.254.169.254/asset.tar.gz",
        ),
      });
      expect(contacted).toHaveLength(1);
      expect(contacted[0]).toContain("/LuaLS/lua-language-server/releases/download/");
      expect(cancelFn).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      globalThis.fetch = originalFetch;
      fs.rmSync(tempTarget, { recursive: true, force: true });
    }
  });

  it("surfaces untrusted redirect error when body has no cancel or cancel rejects", async () => {
    const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-redirect-nocancel-"));
    const originalFetch = globalThis.fetch;
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: "https://evil-mirror.com/asset.tar.gz",
        body: Readable.from(["payload"]),
      } as unknown as Response);
      await expect(
        downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
      ).rejects.toMatchObject({ code: "ERR_LUALS_DOWNLOAD" });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const rejectingCancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        url: "https://evil-mirror.com/asset.tar.gz",
        body: { cancel: rejectingCancel },
      } as unknown as Response);
      await expect(
        downloadAndExtractLuaLS("3.19.1", tempTarget, { reuseExisting: false }),
      ).rejects.toMatchObject({ code: "ERR_LUALS_DOWNLOAD" });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(rejectingCancel).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      globalThis.fetch = originalFetch;
      fs.rmSync(tempTarget, { recursive: true, force: true });
    }
  });
});
