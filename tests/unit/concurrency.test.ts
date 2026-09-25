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
  touchLockFile,
  withFileLock,
  writeAtomicFile,
  writeAtomicFileSync,
} from "../../src/lock.js";
import { logger } from "../../src/logger.js";
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
    // The overlap verdict is taken inside the critical section (exclusive-create marker
    // plus an owner-token read-back) rather than from a shared append log: Windows file
    // writes from sibling processes are not a reliable ordering signal, so a log-based
    // nesting check reports false overlaps under load.
    const rounds = 2;
    const ids = ["a", "b", "c", "d", "e", "f"];

    for (let round = 0; round < rounds; round++) {
      const dir = makeTempDir(`nanos-lock-multiprocess-${round}-`);
      const lockPath = path.join(dir, "shared.lock");
      const markerPath = path.join(dir, "critical.marker");
      const logPath = path.join(dir, "critical.log");
      const workerScript = path.join(dir, "worker.mjs");
      const lockUrl = pathToFileURL(path.join(repoRoot, "src", "lock.ts")).href;

      fs.writeFileSync(
        workerScript,
        [
          'import fs from "node:fs";',
          `import { withFileLock } from ${JSON.stringify(lockUrl)};`,
          "const [lockPath, markerPath, logPath, reportPath, id] = process.argv.slice(2);",
          "const notes = [];",
          "let token = null;",
          "await withFileLock(lockPath, async () => {",
          "  token = JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token;",
          "  fs.appendFileSync(logPath, `start-${id}\\n`);",
          "  try {",
          "    fs.writeFileSync(markerPath, `${id}:${token}`, { flag: 'wx' });",
          "  } catch {",
          "    notes.push('marker-exists:' + (fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf-8') : '?'));",
          "  }",
          "  await new Promise((resolve) => setTimeout(resolve, 30));",
          "  if (fs.existsSync(markerPath)) {",
          "    const owner = fs.readFileSync(markerPath, 'utf-8');",
          "    if (owner.startsWith(`${id}:`)) fs.unlinkSync(markerPath);",
          "    else notes.push('marker-stolen-by:' + owner);",
          "  }",
          "  const current = JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token;",
          "  if (current !== token) notes.push('lock-token-changed:' + token + '->' + current);",
          "  fs.appendFileSync(logPath, `end-${id}\\n`);",
          '}, { label: "worker" });',
          "fs.writeFileSync(reportPath, JSON.stringify({ id, pid: process.pid, token, notes }));",
        ].join("\n"),
        "utf-8",
      );

      const results = await Promise.all(
        ids.map(async (id) => {
          const reportPath = path.join(dir, `report-${id}.json`);
          try {
            const { stderr } = await execFileAsync(
              process.execPath,
              ["--import", "tsx", workerScript, lockPath, markerPath, logPath, reportPath, id],
              { cwd: repoRoot, timeout: 60_000 },
            );
            return {
              id,
              stderr,
              report: JSON.parse(fs.readFileSync(reportPath, "utf-8")) as {
                notes: string[];
                token: string;
              },
            };
          } catch (err) {
            throw new Error(
              `worker ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
        }),
      );

      const diagnostics = results
        .map(
          (result) =>
            `${result.id}: ${result.report.notes.join(", ")}${result.stderr.trim() ? ` [stderr] ${result.stderr.trim()}` : ""}`,
        )
        .join("\n");
      const overlaps = results.flatMap((result) => result.report.notes);
      expect(overlaps, `overlapping critical sections in round ${round}:\n${diagnostics}`).toEqual(
        [],
      );
      expect(results.every((result) => result.report.token !== null)).toBe(true);
      expect(new Set(results.map((result) => result.report.token)).size).toBe(ids.length);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);

      const log = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      expect(log, `unbalanced critical-section log:\n${diagnostics}`).toHaveLength(ids.length * 2);
      for (const id of ids) {
        expect(log.filter((line) => line === `start-${id}`)).toHaveLength(1);
        expect(log.filter((line) => line === `end-${id}`)).toHaveLength(1);
      }
    }
  }, 180000);

  it("reclaims a lock whose owner process is gone", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-dead-"), "stale.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999, createdAt: Date.now(), token: "orphan" }),
    );
    expect(isLockStale(lockPath)).toBe(true);

    await expect(
      withFileLock(lockPath, () => "recovered", {
        timeoutMs: 2000,
        staleMs: 50,
        reclaimGraceMs: 0,
      }),
    ).resolves.toBe("recovered");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not reclaim an abandoned-looking lock before the grace period elapses", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-grace-"), "fresh.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999, createdAt: Date.now(), token: "fresh-orphan" }),
    );

    await expect(
      withFileLock(lockPath, () => "stolen", {
        timeoutMs: 250,
        staleMs: 0,
        reclaimGraceMs: 60_000,
      }),
    ).rejects.toThrow(/Timed out after 250ms/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("reclaims an expired lock whose recorded pid is still alive", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-expired-"), "expired.lock");
    const expiredTimestamp = Date.now() - DEFAULT_LOCK_STALE_MS - 1000;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: expiredTimestamp,
        token: "expired",
      }),
    );
    const expiredSeconds = expiredTimestamp / 1000;
    fs.utimesSync(lockPath, expiredSeconds, expiredSeconds);

    await expect(
      withFileLock(lockPath, () => "recovered", { timeoutMs: 2000, staleMs: 50 }),
    ).resolves.toBe("recovered");
  });

  it("treats a Windows create failure on an existing lock as contention", async () => {
    // Windows reports EPERM/EACCES/EBUSY instead of EEXIST while another process is
    // deleting or swapping the lock file; that must not surface as a hard failure.
    const lockPath = path.join(makeTempDir("nanos-lock-contended-"), "contended.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999, createdAt: Date.now() - 60_000, token: "orphan" }),
    );
    const realOpenSync = fs.openSync;
    let injected = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      if (!injected && String(args[0]) === lockPath) {
        injected = true;
        const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return realOpenSync(...args);
    }) as typeof fs.openSync);

    try {
      await expect(
        withFileLock(lockPath, () => "acquired", {
          timeoutMs: 2000,
          staleMs: 50,
          reclaimGraceMs: 0,
        }),
      ).resolves.toBe("acquired");
      expect(injected).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("propagates create failures that are not contention", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-create-error-"), "broken.lock");
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }) as typeof fs.openSync);

    try {
      await expect(withFileLock(lockPath, () => "never")).rejects.toThrow(/ENOENT/);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("reclaims an old lock whose metadata was never written completely", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-garbage-"), "truncated.lock");
    fs.writeFileSync(lockPath, '{"pid":');
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, old, old);

    await expect(
      withFileLock(lockPath, () => "recovered", {
        timeoutMs: 2000,
        staleMs: 50,
        reclaimGraceMs: 0,
      }),
    ).resolves.toBe("recovered");
    expect(fs.existsSync(lockPath)).toBe(false);
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

describe("lock heartbeat (#44)", () => {
  it("touchLockFile updates mtime non-destructively while verifying token ownership", () => {
    const lockPath = path.join(makeTempDir("nanos-lock-touch-"), "test.lock");
    const oldSeconds = 1000;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 50_000, token: "owner-token" }),
    );
    fs.utimesSync(lockPath, oldSeconds, oldSeconds);

    const initialStat = fs.statSync(lockPath);

    expect(touchLockFile(lockPath, "wrong-token")).toBe(false);
    expect(fs.statSync(lockPath).mtimeMs).toBe(initialStat.mtimeMs);

    expect(
      touchLockFile(path.join(makeTempDir("nanos-missing-"), "missing.lock"), "owner-token"),
    ).toBe(false);

    expect(touchLockFile(lockPath, "owner-token")).toBe(true);
    const updatedStat = fs.statSync(lockPath);
    expect(updatedStat.mtimeMs).toBeGreaterThan(initialStat.mtimeMs);

    const content = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
      createdAt: number;
      token: string;
      pid: number;
    };
    expect(content.token).toBe("owner-token");
    expect(content.pid).toBe(process.pid);

    const utimesSpy = vi.spyOn(fs, "utimesSync").mockImplementationOnce(() => {
      const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    try {
      expect(touchLockFile(lockPath, "owner-token")).toBe(false);
    } finally {
      utimesSpy.mockRestore();
    }
  });

  it("advances mtime via periodic heartbeat while a slow task runs", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-heartbeat-"), "heartbeat.lock");
    let initialMtimeMs = 0;
    const timestamps: number[] = [];

    await withFileLock(
      lockPath,
      async () => {
        initialMtimeMs = fs.statSync(lockPath).mtimeMs;

        for (let i = 0; i < 3; i++) {
          await delay(35);
          timestamps.push(fs.statSync(lockPath).mtimeMs);
          expect(isLockStale(lockPath, 40)).toBe(false);
        }
      },
      { heartbeatIntervalMs: 20 },
    );

    expect(timestamps).toHaveLength(3);
    expect(timestamps[0]).toBeGreaterThan(initialMtimeMs);
    expect(timestamps[1]).toBeGreaterThan(timestamps[0]!);
    expect(timestamps[2]).toBeGreaterThan(timestamps[1]!);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("stops the heartbeat timer cleanly on task completion and failure", async () => {
    const dir = makeTempDir("nanos-lock-heartbeat-stop-");
    const lockPath1 = path.join(dir, "complete.lock");
    const lockPath2 = path.join(dir, "fail.lock");
    const oldSec = 1000;

    await withFileLock(
      lockPath1,
      async () => {
        await delay(25);
      },
      { heartbeatIntervalMs: 15 },
    );
    expect(fs.existsSync(lockPath1)).toBe(false);

    fs.writeFileSync(
      lockPath1,
      JSON.stringify({ pid: process.pid, createdAt: 1000, token: "dummy" }),
    );
    fs.utimesSync(lockPath1, oldSec, oldSec);
    await delay(40);
    expect(fs.statSync(lockPath1).mtimeMs).toBe(oldSec * 1000);

    await expect(
      withFileLock(
        lockPath2,
        async () => {
          await delay(25);
          throw new Error("simulated failure");
        },
        { heartbeatIntervalMs: 15 },
      ),
    ).rejects.toThrow("simulated failure");
    expect(fs.existsSync(lockPath2)).toBe(false);

    fs.writeFileSync(
      lockPath2,
      JSON.stringify({ pid: process.pid, createdAt: 1000, token: "dummy2" }),
    );
    fs.utimesSync(lockPath2, oldSec, oldSec);
    await delay(40);
    expect(fs.statSync(lockPath2).mtimeMs).toBe(oldSec * 1000);
  });

  it("handles lost ownership by clearing heartbeat timer and warning", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-lost-owner-"), "lost.lock");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    try {
      await withFileLock(
        lockPath,
        async () => {
          fs.writeFileSync(
            lockPath,
            JSON.stringify({ pid: 999_999, createdAt: Date.now(), token: "usurper-token" }),
          );
          await delay(35);

          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("Lost ownership of lost.lock lock"),
          );
          warnSpy.mockClear();

          await delay(35);
          expect(warnSpy).not.toHaveBeenCalled();
        },
        { heartbeatIntervalMs: 15, label: "lost.lock" },
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns once when heartbeat touch encounters an error", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-touch-err-"), "touch-err.lock");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const utimesSpy = vi.spyOn(fs, "utimesSync").mockImplementation(() => {
      const err = new Error("EIO: i/o error") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });

    try {
      await withFileLock(
        lockPath,
        async () => {
          await delay(50);
        },
        { heartbeatIntervalMs: 15, label: "touch-err.lock" },
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to touch touch-err.lock lock"),
      );
    } finally {
      utimesSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("disables heartbeat when staleMs <= 0 or heartbeatIntervalMs <= 0", async () => {
    const dir = makeTempDir("nanos-lock-disabled-");
    const lock1 = path.join(dir, "disabled-stale.lock");
    const lock2 = path.join(dir, "disabled-opt.lock");
    const oldSec = 1000;

    await withFileLock(
      lock1,
      async () => {
        fs.utimesSync(lock1, oldSec, oldSec);
        await delay(40);
        expect(fs.statSync(lock1).mtimeMs).toBe(oldSec * 1000);
      },
      { staleMs: 0 },
    );

    await withFileLock(
      lock2,
      async () => {
        fs.utimesSync(lock2, oldSec, oldSec);
        await delay(40);
        expect(fs.statSync(lock2).mtimeMs).toBe(oldSec * 1000);
      },
      { staleMs: 100, heartbeatIntervalMs: 0 },
    );
  });

  it("postpones stale timeout as long as the heartbeat is beating", async () => {
    const lockPath = path.join(makeTempDir("nanos-lock-heartbeat-stale-"), "stale.lock");
    let worker1Finished = false;
    let worker2StartedWhileWorker1Running = false;

    const worker1 = withFileLock(
      lockPath,
      async () => {
        for (let i = 0; i < 5; i++) {
          await delay(25);
          expect(isLockStale(lockPath, 60)).toBe(false);
        }
        worker1Finished = true;
      },
      { staleMs: 60, heartbeatIntervalMs: 15 },
    );

    await delay(10);

    const worker2 = withFileLock(
      lockPath,
      async () => {
        if (!worker1Finished) {
          worker2StartedWhileWorker1Running = true;
        }
      },
      { staleMs: 60, timeoutMs: 3000, pollIntervalMs: 10, reclaimGraceMs: 0 },
    );

    await Promise.all([worker1, worker2]);

    expect(worker1Finished).toBe(true);
    expect(worker2StartedWhileWorker1Running).toBe(false);
  });

  it("proves that without heartbeat the lock becomes stale, but with heartbeat it stays fresh", async () => {
    const dir = makeTempDir("nanos-lock-compare-");
    const lockWithoutHeartbeat = path.join(dir, "no-heartbeat.lock");
    const lockWithHeartbeat = path.join(dir, "heartbeat.lock");

    await withFileLock(
      lockWithoutHeartbeat,
      async () => {
        await delay(80);
        expect(isLockStale(lockWithoutHeartbeat, 40)).toBe(true);
      },
      { staleMs: 40, heartbeatIntervalMs: 0 },
    );

    await withFileLock(
      lockWithHeartbeat,
      async () => {
        await delay(80);
        expect(isLockStale(lockWithHeartbeat, 40)).toBe(false);
      },
      { staleMs: 40, heartbeatIntervalMs: 10 },
    );
  });

  it("prevents cross-process lock reclaim for long-running task beating past staleMs", async () => {
    const dir = makeTempDir("nanos-lock-cross-process-heartbeat-");
    const lockPath = path.join(dir, "cross.lock");
    const markerPath = path.join(dir, "worker.marker");
    const workerScript = path.join(dir, "worker.mjs");
    const lockUrl = pathToFileURL(path.join(repoRoot, "src", "lock.ts")).href;

    fs.writeFileSync(
      workerScript,
      [
        'import fs from "node:fs";',
        `import { withFileLock } from ${JSON.stringify(lockUrl)};`,
        "const [lockPath, markerPath] = process.argv.slice(2);",
        "await withFileLock(lockPath, async () => {",
        "  fs.writeFileSync(markerPath, 'running');",
        "  await new Promise((resolve) => setTimeout(resolve, 120));",
        "  fs.unlinkSync(markerPath);",
        "}, { staleMs: 50, heartbeatIntervalMs: 12 });",
      ].join("\n"),
      "utf-8",
    );

    const child = execFileAsync(
      process.execPath,
      ["--import", "tsx", workerScript, lockPath, markerPath],
      { cwd: repoRoot, timeout: 30_000 },
    );

    while (!fs.existsSync(markerPath)) {
      await delay(5);
    }

    let parentAcquiredWhileWorkerRan = false;
    await withFileLock(
      lockPath,
      () => {
        if (fs.existsSync(markerPath)) {
          parentAcquiredWhileWorkerRan = true;
        }
      },
      { staleMs: 50, timeoutMs: 5000, reclaimGraceMs: 0 },
    );

    await child;

    expect(parentAcquiredWhileWorkerRan).toBe(false);
  });
});
