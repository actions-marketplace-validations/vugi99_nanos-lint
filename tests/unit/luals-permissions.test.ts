import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertValidLuaLSBinary,
  isBinaryRunnable,
  isBinaryValid,
} from "../../src/luals/validation.js";
import {
  findExistingLuaLSDir,
  getIsoWeek,
  listCachedLuaLSVersions,
} from "../../src/luals/cache.js";
import { downloadAndExtractLuaLS } from "../../src/luals/download.js";
import { getPlatformInfo } from "../../src/luals/platform.js";
import { resolveLuaLSBinary } from "../../src/luals/runner.js";

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: probe,
}));

describe("LuaLS validation permissions (#53)", () => {
  const version = "3.19.1";
  let cacheDir: string;
  let installDir: string;
  let binary: string;
  let permissionError: Error;

  beforeEach(() => {
    vi.stubEnv("LUALS_BIN", "");
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-luals-permissions-"));
    installDir = path.join(cacheDir, version);
    binary = path.join(installDir, getPlatformInfo(version).binaryRelativePath);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, Buffer.alloc(100_000));
    fs.writeFileSync(path.join(installDir, ".complete"), version);
    permissionError = Object.assign(new Error("spawnSync blocked by policy"), {
      code: "EPERM",
      status: 0,
      stdout: Buffer.from(`${version}\n`),
      stderr: Buffer.alloc(0),
    });
    probe.mockReset().mockImplementation(() => {
      throw permissionError;
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it.each(["EPERM", "EACCES"])("reports %s even with successful child output", (code) => {
    Object.assign(permissionError, { code });
    for (const validate of [isBinaryValid, isBinaryRunnable]) {
      expect(() => validate(binary)).toThrow(
        expect.objectContaining({
          code: "ERR_LUALS_EXECUTION_DENIED",
          cause: permissionError,
          message: expect.stringContaining(`${binary}': ${code}`),
          remedy: expect.stringContaining("sandbox policy"),
        }),
      );
    }
    expect(() => assertValidLuaLSBinary(binary, "LUALS_BIN")).toThrow(
      expect.objectContaining({ code: "ERR_LUALS_EXECUTION_DENIED" }),
    );
  });

  it.each(["explicit", "weekly", "enumerated", "download"])(
    "preserves a blocked cache during %s resolution without repair or network access",
    async (route) => {
      if (route === "weekly") {
        fs.writeFileSync(
          path.join(cacheDir, "metadata.json"),
          JSON.stringify({ latestVersion: version, lastCheckedWeek: getIsoWeek() }),
        );
      }
      const remove = vi.spyOn(fs, "rmSync");
      const mkdir = vi.spyOn(fs, "mkdirSync");
      const operation =
        route === "download"
          ? downloadAndExtractLuaLS(version, installDir, { cacheDir })
          : resolveLuaLSBinary(route === "explicit" ? version : "latest", { cacheDir });
      await expect(operation).rejects.toMatchObject({
        code: "ERR_LUALS_EXECUTION_DENIED",
        cause: permissionError,
      });
      expect(remove).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(installDir, ".complete"), "utf8")).toBe(version);
      expect(fs.statSync(binary).size).toBe(100_000);
    },
  );

  it("propagates blocked probes through cache discovery helpers", () => {
    for (const operation of [
      () => listCachedLuaLSVersions(cacheDir),
      () => findExistingLuaLSDir(version, cacheDir),
    ]) {
      expect(operation).toThrow(expect.objectContaining({ code: "ERR_LUALS_EXECUTION_DENIED" }));
    }
  });

  it("reports denied binary metadata access instead of marking the file corrupt", () => {
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw denied;
    });
    expect(() => isBinaryValid(binary)).toThrow(
      expect.objectContaining({ code: "ERR_LUALS_CACHE_PERMISSION", cause: denied }),
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("surfaces cache repair permissions without hiding them behind a network remedy", async () => {
    probe.mockReturnValue("invalid output");
    const denied = Object.assign(new Error("cannot remove cache"), { code: "EACCES" });
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw denied;
    });
    await expect(resolveLuaLSBinary(version, { cacheDir })).rejects.toMatchObject({
      code: "ERR_LUALS_CACHE_PERMISSION",
      cause: denied,
      message: expect.stringContaining(installDir),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still repairs a genuinely nonfunctional cached binary", async () => {
    probe.mockImplementation(() => {
      throw Object.assign(new Error("failed execution"), { status: 1 });
    });
    expect(isBinaryValid(binary)).toBe(false);
    const remove = vi.spyOn(fs, "rmSync");
    await expect(resolveLuaLSBinary(version, { cacheDir })).rejects.toMatchObject({
      code: "ERR_LUALS_CORRUPTED_CACHE",
    });
    expect(remove).toHaveBeenCalledWith(installDir, { recursive: true, force: true });
    expect(fetch).toHaveBeenCalled();
    expect(fs.existsSync(binary)).toBe(false);
  });
});
