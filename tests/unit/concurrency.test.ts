import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_LOCK_STALE_MS,
  isLockStale,
  releaseFileLock,
  withFileLock,
  writeAtomicFile,
  writeAtomicFileSync,
} from "../../src/lock.js";
import {
  FALLBACK_LUALS_VERSION,
  downloadAndExtractLuaLS,
  getIsoWeek,
  isBinaryValid,
  readLuaLSMetadata,
  writeLuaLSMetadata,
} from "../../src/luals.js";
import {
  getTodayDateString,
  isAnnotationsValid,
  readAnnotationsMetadata,
  resolveAnnotations,
  updateLastCheckedDate,
} from "../../src/annotations.js";
import { getSharedAnnotations, isLiveTestsEnabled, seedCachedLuaLS } from "../helpers/live.js";

const execFileAsync = promisify(execFile);
const liveTestsEnabled = isLiveTestsEnabled();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDirs: string[] = [];

/** Creates an isolated scratch directory removed after the test. */
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Sleeps so concurrent workers overlap inside the critical section. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }
});

describe("concurrent cache access (#7)", () => {
  it("keeps metadata files parseable while 25 writers race", async () => {
    const lualsDir = makeTempDir("nanos-concurrent-luals-");
    const annotationsDir = makeTempDir("nanos-concurrent-annotations-");
    const lualsMeta = path.join(lualsDir, "metadata.json");
    const annotationsMeta = path.join(annotationsDir, "metadata.json");
    let parseErrors = 0;
    let reads = 0;

    const writers = Array.from({ length: 25 }, async (_unused, index) => {
      await delay(index % 4);
      writeLuaLSMetadata(
        {
          lastCheckedWeek: getIsoWeek(),
          latestVersion: `3.19.${index}`,
          lastCheckedDate: "2026-01-01",
        },
        lualsDir,
      );
      updateLastCheckedDate(`commit-${index}`, annotationsDir);
    });

    const readers = Array.from({ length: 5 }, async () => {
      for (let i = 0; i < 60; i++) {
        for (const file of [lualsMeta, annotationsMeta]) {
          if (!fs.existsSync(file)) continue;
          try {
            JSON.parse(fs.readFileSync(file, "utf-8"));
            reads += 1;
          } catch (err) {
            void err;
            parseErrors += 1;
          }
        }
        await delay(1);
      }
    });

    await Promise.all([...writers, ...readers]);

    expect(parseErrors).toBe(0);
    expect(reads).toBeGreaterThan(0);
    expect(readLuaLSMetadata(lualsDir)?.lastCheckedWeek).toBe(getIsoWeek());
    expect(readAnnotationsMetadata(annotationsDir)?.commitId).toMatch(/^commit-\d+$/);
  });

  it("serializes workers so no two enter the critical section together", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-mutex-"), "critical.lock");
    let active = 0;
    let maxActive = 0;
    const completed: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) =>
        withFileLock(lockPath, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(5);
          completed.push(index);
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(1);
    expect(completed).toHaveLength(8);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("serializes separate processes on the same lock file", async () => {
    const dir = makeTempDir("nanos-lock-multiprocess-");
    const lockPath = path.join(dir, "shared.lock");
    const logPath = path.join(dir, "critical.log");
    const workerScript = path.join(dir, "worker.mjs");
    const lockUrl = pathToFileURL(path.join(repoRoot, "src", "lock.ts")).href;

    fs.writeFileSync(
      workerScript,
      [
        'import fs from "node:fs";',
        `import { withFileLock } from ${JSON.stringify(lockUrl)};`,
        "const [lockPath, logPath, id] = process.argv.slice(2);",
        "await withFileLock(lockPath, async () => {",
        "  fs.appendFileSync(logPath, `start-${id}\\n`);",
        "  await new Promise((resolve) => setTimeout(resolve, 40));",
        "  fs.appendFileSync(logPath, `end-${id}\\n`);",
        '}, { label: "worker" });',
      ].join("\n"),
      "utf-8",
    );

    const workers = await Promise.all(
      ["a", "b", "c", "d"].map(async (id) => {
        try {
          const { stderr } = await execFileAsync(
            process.execPath,
            ["--import", "tsx", workerScript, lockPath, logPath, id],
            { cwd: repoRoot, timeout: 60_000 },
          );
          return stderr;
        } catch (err) {
          throw new Error(
            `worker ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }),
    );
    expect(workers.every((stderr) => typeof stderr === "string")).toBe(true);

    const events = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(events).toHaveLength(8);
    expect(new Set(events.filter((line) => line.startsWith("start-"))).size).toBe(4);
    const open: string[] = [];
    for (const event of events) {
      const [kind, id] = event.split("-");
      if (kind === "start") {
        expect(open).toHaveLength(0);
        open.push(id!);
      } else {
        expect(open.pop()).toBe(id);
      }
    }
    expect(open).toHaveLength(0);
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 120000);

  it("reclaims a lock whose owner process is gone", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-dead-"), "stale.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999, createdAt: Date.now(), token: "orphan" }),
    );
    expect(isLockStale(lockPath)).toBe(true);

    await expect(
      withFileLock(lockPath, () => "recovered", { timeoutMs: 2000, staleMs: 50 }),
    ).resolves.toBe("recovered");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims an expired lock whose recorded pid is still alive", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-expired-"), "expired.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now() - DEFAULT_LOCK_STALE_MS - 1000,
        token: "expired",
      }),
    );

    await expect(
      withFileLock(lockPath, () => "recovered", { timeoutMs: 2000, staleMs: 50 }),
    ).resolves.toBe("recovered");
  });

  it("times out instead of hanging on a fresh lock held by a live process", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-timeout-"), "held.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "held" }),
    );

    await expect(
      withFileLock(lockPath, () => "unreachable", {
        timeoutMs: 100,
        staleMs: 60_000,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(/Timed out after 100ms/);
  });

  it("never deletes a lock that another owner re-acquired", () => {
    const lockPath = path.join(makeTempDir("nanos-lock-owner-"), "owned.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "other-owner" }),
    );

    releaseFileLock(lockPath, "my-token");

    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("replaces files atomically and leaves no scratch files behind", async () => {
    const dir = makeTempDir("nanos-atomic-");
    const target = path.join(dir, "data.json");

    writeAtomicFileSync(target, JSON.stringify({ version: 1 }));
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ version: 1 });

    await writeAtomicFile(target, JSON.stringify({ version: 2 }));
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ version: 2 });

    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
  });

  it("retries transient rename failures and cleans up after a hard failure", () => {
    const dir = makeTempDir("nanos-atomic-retry-");
    const target = path.join(dir, "retried.json");
    const realRename = fs.renameSync;
    let attempts = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return realRename(from, to);
    });

    try {
      writeAtomicFileSync(target, "payload");
      expect(attempts).toBe(2);
      expect(fs.readFileSync(target, "utf-8")).toBe("payload");
    } finally {
      renameSpy.mockRestore();
    }

    const failingSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    });
    try {
      expect(() => writeAtomicFileSync(target, "payload")).toThrow(/ENOSPC/);
    } finally {
      failingSpy.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual(["retried.json"]);
  });

  it.skipIf(!liveTestsEnabled)(
    "resolves annotations once for ten parallel callers on a cold cache",
    async () => {
      const cacheDir = makeTempDir("nanos-concurrent-annotations-cold-");
      const sharedAnnotations = await getSharedAnnotations();
      const content = fs.readFileSync(sharedAnnotations, "utf-8");
      const originalFetch = globalThis.fetch;
      let rawFetches = 0;

      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const { hostname } = new URL(raw);
        if (hostname === "api.github.com") {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => JSON.stringify({ sha: "abcdef0123456789" }),
          } as unknown as Response;
        }
        rawFetches += 1;
        await delay(5);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => content,
        } as unknown as Response;
      }) as unknown as typeof fetch;

      try {
        const resolved = await Promise.all(
          Array.from({ length: 10 }, () => resolveAnnotations({ cacheDir })),
        );

        expect(new Set(resolved).size).toBe(1);
        expect(rawFetches).toBe(1);
        expect(isAnnotationsValid(resolved[0]!)).toBe(true);
        expect(readAnnotationsMetadata(cacheDir)?.commitId).toBe("abcdef0123456789");
        expect(readAnnotationsMetadata(cacheDir)?.lastChecked).toBe(getTodayDateString().dateStr);
        expect(fs.readdirSync(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

describe.skipIf(!liveTestsEnabled)("concurrent LuaLS installation (#7)", () => {
  it("installs the binary once when four workers target the same cache directory", async () => {
    const seedBase = makeTempDir("nanos-concurrent-seed-");
    const targetBase = makeTempDir("nanos-concurrent-target-");
    await seedCachedLuaLS(seedBase, FALLBACK_LUALS_VERSION);
    const targetDir = path.join(targetBase, FALLBACK_LUALS_VERSION);
    const copySpy = vi.spyOn(fs, "cpSync");

    try {
      const binaries = await Promise.all(
        Array.from({ length: 4 }, () =>
          downloadAndExtractLuaLS(FALLBACK_LUALS_VERSION, targetDir, { cacheDir: seedBase }),
        ),
      );

      expect(new Set(binaries).size).toBe(1);
      expect(copySpy).toHaveBeenCalledTimes(1);
      expect(isBinaryValid(binaries[0]!)).toBe(true);
      expect(fs.readFileSync(path.join(targetDir, ".complete"), "utf-8")).toBe(
        FALLBACK_LUALS_VERSION,
      );

      const leftovers = fs
        .readdirSync(targetBase)
        .filter((name) => name.includes(".tmp-") || name.endsWith(".lock"));
      expect(leftovers).toEqual([]);
    } finally {
      copySpy.mockRestore();
    }
  }, 120000);
});
