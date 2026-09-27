import fs from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "../../src/logger.js";
import { trackDownloadProgress } from "../../src/luals.js";
import {
  createProgressBar,
  createSpinner,
  formatTransferSummary,
  getProgressMode,
  isProgressInteractive,
  restoreTerminal,
  setProgressMode,
  PROGRESS_MILESTONES,
  PROGRESS_THROTTLE_MS,
  SPINNER_FRAMES,
  type ProgressOptions,
  type ProgressStream,
} from "../../src/terminal-progress.js";

interface TestStream extends ProgressStream {
  chunks: string[];
  text(): string;
}

function makeStream(columns = 120, isTTY: boolean | undefined = true): TestStream {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY,
    columns,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(""),
  };
}

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const CURSOR_HIDE = "\u001b[?25l";
const CURSOR_SHOW = "\u001b[?25h";

describe("terminal progress", () => {
  const originalEnv = { ...process.env };
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  const barOptions = (overrides: Partial<ProgressOptions> = {}): ProgressOptions => ({
    label: "[luals] Downloading lua-language-server.tar.gz",
    total: 1000,
    interactive: true,
    announce: false,
    ...overrides,
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TERM;
    delete process.env.CI;
    delete process.env.NO_COLOR;
    delete process.env.NANOS_NO_PROGRESS;
    setProgressMode("auto");
    logger.setLevel("info");
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stderr = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    setProgressMode("auto");
    logger.setLevel("warn");
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.useRealTimers();
    expect(getProgressMode()).toBe("auto");
  });

  describe("isProgressInteractive", () => {
    it("requires a TTY", () => {
      expect(isProgressInteractive({}, true)).toBe(true);
      expect(isProgressInteractive({}, false)).toBe(false);
      expect(isProgressInteractive({}, undefined)).toBe(false);
    });

    it("disables redrawing in CI, dumb terminals, NO_COLOR and opt-out runs", () => {
      expect(isProgressInteractive({ CI: "true" }, true)).toBe(false);
      expect(isProgressInteractive({ CI: "1" }, true)).toBe(false);
      expect(isProgressInteractive({ TERM: "dumb" }, true)).toBe(false);
      expect(isProgressInteractive({ NO_COLOR: "1" }, true)).toBe(false);
      expect(isProgressInteractive({ NANOS_NO_PROGRESS: "1" }, true)).toBe(false);
    });

    it("honours false-like environment values", () => {
      for (const value of ["", "0", "false", "FALSE", "no", "off", " "]) {
        expect(isProgressInteractive({ CI: value }, true)).toBe(true);
        expect(isProgressInteractive({ NO_COLOR: value }, true)).toBe(true);
        expect(isProgressInteractive({ NANOS_NO_PROGRESS: value }, true)).toBe(true);
      }
      expect(isProgressInteractive({ TERM: "xterm-256color" }, true)).toBe(true);
    });

    it("disables redrawing when the mode is off or the logger is silent", () => {
      setProgressMode("off");
      expect(isProgressInteractive({}, true)).toBe(false);
      setProgressMode("auto");
      logger.setLevel("silent");
      expect(isProgressInteractive({}, true)).toBe(false);
    });
  });

  describe("formatTransferSummary", () => {
    it("formats size, duration and average speed", () => {
      expect(formatTransferSummary(1024 * 1024, 1000)).toBe("1.00 MB in 1.0s (1.00 MB/s)");
      expect(formatTransferSummary(0, 0)).toBe("0 B in 0.0s (0 B/s)");
      expect(formatTransferSummary(2048, 20_000)).toBe("2.00 KB in 20s (102 B/s)");
    });
  });

  describe("progress bar (interactive)", () => {
    it("renders percentage, transferred bytes, speed and ETA", () => {
      const stream = makeStream();
      const clock = makeClock();
      const bar = createProgressBar(barOptions({ stream, now: clock.now, throttleMs: 10 }));

      expect(stream.text()).toContain("0%");
      clock.advance(1000);
      bar.update(500);

      const frame = stream.text();
      expect(frame).toContain("\r\u001b[2K");
      expect(frame).toContain("50%");
      expect(frame).toContain("500 B / 1000 B");
      expect(frame).toContain("500 B/s");
      expect(frame).toContain("ETA 1.0s");
      expect(frame).toContain("[luals] Downloading lua-language-server.tar.gz [");
      expect(frame).toContain(">");
      bar.finish();
    });

    it("renders a full bar and drops the ETA once complete", () => {
      const stream = makeStream();
      const clock = makeClock();
      const bar = createProgressBar(barOptions({ stream, now: clock.now, throttleMs: 1 }));

      clock.advance(1000);
      bar.update(1000);
      bar.finish();

      const frame = stream.text();
      expect(frame).toContain("100%");
      expect(frame).not.toContain("ETA");
      expect(frame).toContain("=".repeat(8));
    });

    it("shows transferred bytes and speed when the total size is unknown", () => {
      const stream = makeStream();
      const clock = makeClock();
      const bar = createProgressBar(
        barOptions({ stream, now: clock.now, throttleMs: 1, total: undefined }),
      );

      clock.advance(2000);
      bar.update(4096);
      bar.finish();

      const frame = stream.text();
      expect(frame).toContain("4.00 KB");
      expect(frame).toContain("2.00 KB/s");
      expect(frame).not.toContain("%");
    });

    it("accepts a total reported by the transport after creation", () => {
      const stream = makeStream();
      const clock = makeClock();
      const bar = createProgressBar(
        barOptions({ stream, now: clock.now, throttleMs: 1, total: undefined }),
      );

      clock.advance(1000);
      bar.update(250, 1000);
      bar.finish();

      expect(stream.text()).toContain("25%");
    });

    it("drops a declared total the transfer has already passed", () => {
      const stream = makeStream();
      const clock = makeClock();
      const bar = createProgressBar(barOptions({ stream, now: clock.now, throttleMs: 1 }));

      clock.advance(1000);
      bar.update(4000);
      bar.finish();

      const frames = stream.chunks.filter(
        (chunk) => chunk.startsWith("\r\u001b[2K") && chunk.length > 5,
      );
      expect(frames.length).toBeGreaterThan(0);
      const lastFrame = frames[frames.length - 1] ?? "";
      expect(lastFrame).not.toContain("%");
      expect(lastFrame).toContain("3.91 KB");
    });

    it("throttles redraws but renders the final state", () => {
      const stream = makeStream();
      const clock = makeClock();
      const bar = createProgressBar(barOptions({ stream, now: clock.now, throttleMs: 100 }));

      const afterCreation = stream.chunks.length;
      for (let index = 1; index <= 50; index++) {
        clock.advance(10);
        bar.update(index * 20);
      }

      expect(stream.chunks.length - afterCreation).toBeLessThan(50);
      const beforeFinish = stream.chunks.length;
      bar.finish();
      expect(stream.chunks.length).toBeGreaterThan(beforeFinish);
    });

    it("hides the cursor while running and restores it on completion", () => {
      const stream = makeStream();
      const clock = makeClock();
      const bar = createProgressBar(barOptions({ stream, now: clock.now, throttleMs: 1 }));

      clock.advance(500);
      bar.update(10);
      expect(stream.text()).toContain(CURSOR_HIDE);
      expect(stream.text()).not.toContain(CURSOR_SHOW);

      bar.finish();
      expect(stream.text()).toContain(CURSOR_SHOW);
    });

    it("restores the cursor when the transfer fails", () => {
      const stream = makeStream();
      const clock = makeClock();
      const bar = createProgressBar(barOptions({ stream, now: clock.now, throttleMs: 1 }));

      clock.advance(500);
      bar.update(10);
      bar.fail("download failed");

      expect(stream.text()).toContain(CURSOR_SHOW);
      expect(stderr).toHaveBeenCalledWith("download failed");
    });

    it("leaves the completion message as a permanent log line", () => {
      const stream = makeStream();
      const clock = makeClock();
      const bar = createProgressBar(barOptions({ stream, now: clock.now, throttleMs: 1 }));

      bar.finish("[luals] Downloaded 1.00 KB in 1.0s (1.00 KB/s)");
      expect(stdout).toHaveBeenCalledWith("[luals] Downloaded 1.00 KB in 1.0s (1.00 KB/s)");
    });

    it("fits frames to the terminal width and truncates long labels", () => {
      const stream = makeStream(60);
      const clock = makeClock();
      const bar = createProgressBar(
        barOptions({
          stream,
          now: clock.now,
          throttleMs: 1,
          label: `[luals] ${"very-long-label-".repeat(8)}`,
        }),
      );

      clock.advance(1000);
      bar.update(500);
      bar.finish();

      for (const chunk of stream.chunks) {
        const frame = chunk.replace("\r\u001b[2K", "");
        expect(frame.trimEnd().length).toBeLessThanOrEqual(59);
      }
      expect(stream.text()).toContain("...");
    });

    it("never renders a frame wider than a very narrow terminal", () => {
      const stream = makeStream(10);
      const clock = makeClock();
      const bar = createProgressBar(barOptions({ stream, now: clock.now, throttleMs: 1 }));

      clock.advance(1000);
      bar.update(500);
      bar.finish();

      const frames = stream.chunks.filter((chunk) => chunk.startsWith("\r\u001b[2K"));
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.replace("\r\u001b[2K", "").length).toBeLessThanOrEqual(11);
      }
    });

    it("truncates to a bare ellipsis on absurdly narrow terminals", () => {
      const stream = makeStream(2);
      const clock = makeClock();
      const bar = createProgressBar(barOptions({ stream, now: clock.now, throttleMs: 1 }));

      clock.advance(1000);
      bar.update(500);
      bar.finish();

      const frames = stream.chunks.filter((chunk) => chunk.startsWith("\r\u001b[2K"));
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.replace("\r\u001b[2K", "").length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe("progress bar (non-interactive)", () => {
    it("logs an announcement, milestones and completion without control characters", () => {
      const bar = createProgressBar({
        label: "[luals] Downloading archive.zip",
        total: 1000,
        interactive: false,
      });

      expect(stdout).toHaveBeenCalledWith("[luals] Downloading archive.zip (1000 B)...");
      bar.update(100);
      bar.update(260);
      bar.update(510);
      bar.update(760);
      bar.update(990);
      bar.finish("[luals] Downloaded archive.zip");

      const lines = stdout.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(lines).toEqual([
        "[luals] Downloading archive.zip (1000 B)...",
        "[luals] Downloading archive.zip: 25% (260 B / 1000 B)",
        "[luals] Downloading archive.zip: 50% (510 B / 1000 B)",
        "[luals] Downloading archive.zip: 75% (760 B / 1000 B)",
        "[luals] Downloaded archive.zip",
      ]);
      for (const line of lines) {
        expect(line).not.toContain("\r");
        expect(line).not.toContain("\u001b");
      }
    });

    it("stays silent when announcing is disabled and the total is unknown", () => {
      const bar = createProgressBar({
        label: "quiet",
        interactive: false,
        announce: false,
        total: undefined,
      });

      bar.update(10);
      bar.update(1000);
      bar.finish();
      expect(stdout).not.toHaveBeenCalled();
    });

    it("omits all output at silent log level", () => {
      logger.setLevel("silent");
      const stream = makeStream();
      const bar = createProgressBar(barOptions({ stream, interactive: undefined }));

      bar.update(500);
      bar.finish("[luals] Downloaded");
      bar.fail("boom");

      expect(stream.chunks).toEqual([]);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    });

    it("auto-detects a non-TTY stream", () => {
      const stream = makeStream(80, false);
      const bar = createProgressBar({ label: "auto", total: 10, stream, interactive: undefined });
      bar.finish();

      expect(stream.text()).toBe("");
      expect(stdout).toHaveBeenCalledWith("auto (10 B)...");
    });

    it("auto-detects an interactive TTY stream", () => {
      const stream = makeStream(80, true);
      const bar = createProgressBar({ label: "auto", total: 10, stream, interactive: undefined });
      bar.finish();

      expect(stream.text()).toContain("0%");
      expect(stdout).not.toHaveBeenCalled();
    });
  });

  describe("milestones", () => {
    it("exposes the documented milestone fractions", () => {
      expect(PROGRESS_MILESTONES).toEqual([0.25, 0.5, 0.75]);
      expect(PROGRESS_THROTTLE_MS).toBe(100);
    });
  });

  describe("spinner (interactive)", () => {
    it("animates on a timer and reports the elapsed time", () => {
      vi.useFakeTimers();
      const stream = makeStream();
      const clock = makeClock();
      const spinner = createSpinner({
        label: "[realms] Deriving annotations",
        stream,
        now: clock.now,
        throttleMs: 100,
      });

      spinner.start();
      expect(stream.text()).toContain("[realms] Deriving annotations");
      expect(stream.text()).toContain(SPINNER_FRAMES[0]!);

      clock.advance(100);
      vi.advanceTimersByTime(100);
      expect(stream.text()).toContain(SPINNER_FRAMES[1]!);
      expect(stream.text()).toContain("(0.1s)");

      spinner.stop("[realms] Derived annotations");
      expect(stream.text()).toContain(CURSOR_SHOW);
      expect(stdout).toHaveBeenCalledWith("[realms] Derived annotations");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("advances frames from manual ticks while synchronous work blocks the loop", () => {
      const stream = makeStream();
      const clock = makeClock();
      const spinner = createSpinner({
        label: "step",
        stream,
        now: clock.now,
        throttleMs: 10,
      });

      spinner.start();
      const afterStart = stream.chunks.length;
      for (let index = 0; index < 5; index++) {
        clock.advance(20);
        spinner.tick();
      }
      expect(stream.chunks.length).toBeGreaterThan(afterStart);
      expect(stream.text()).toContain(SPINNER_FRAMES[5]!);
      spinner.stop();
    });

    it("replaces the label mid-run", () => {
      const stream = makeStream();
      const clock = makeClock();
      const spinner = createSpinner({ label: "first", stream, now: clock.now, throttleMs: 1 });

      spinner.start();
      spinner.updateText("second");
      expect(stream.text()).toContain("second");
      spinner.stop();
      expect(stream.text()).toContain(CURSOR_SHOW);
    });

    it("does not arm a second timer when started twice", () => {
      vi.useFakeTimers();
      const stream = makeStream();
      const spinner = createSpinner({ label: "twice", stream, throttleMs: 100 });

      spinner.start();
      spinner.start();
      expect(vi.getTimerCount()).toBe(1);
      spinner.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("restores the cursor when the operation fails", () => {
      const stream = makeStream();
      const spinner = createSpinner({ label: "failing", stream, throttleMs: 100 });

      spinner.start();
      spinner.fail("derivation failed");
      expect(stream.text()).toContain(CURSOR_SHOW);
      expect(stderr).toHaveBeenCalledWith("derivation failed");
    });
  });

  describe("spinner (non-interactive)", () => {
    it("logs the start and completion once, without animation frames", () => {
      const spinner = createSpinner({ label: "[realms] Deriving annotations", interactive: false });

      spinner.start();
      spinner.tick();
      spinner.updateText("[realms] Writing annotations");
      spinner.stop("[realms] Derived annotations");

      expect(stdout.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
        "[realms] Deriving annotations...",
        "[realms] Derived annotations",
      ]);
    });

    it("suppresses the announcement when disabled", () => {
      const spinner = createSpinner({ label: "quiet", interactive: false, announce: false });
      spinner.start();
      spinner.tick();
      spinner.stop();
      expect(stdout).not.toHaveBeenCalled();
    });
  });

  describe("process-level cursor guards", () => {
    it("installs and removes exit and signal guards around a dynamic render", () => {
      const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const before = {
        exit: process.listenerCount("exit"),
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
        crash: process.listenerCount("uncaughtExceptionMonitor"),
      };

      const bar = createProgressBar({ label: "guarded", total: 10, interactive: true });
      expect(process.listenerCount("exit")).toBe(before.exit + 1);
      expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
      expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before.crash + 1);
      expect(write).toHaveBeenCalledWith(CURSOR_HIDE);

      bar.finish();
      expect(process.listenerCount("exit")).toBe(before.exit);
      expect(process.listenerCount("SIGINT")).toBe(before.sigint);
      expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before.crash);
      expect(write).toHaveBeenCalledWith(CURSOR_SHOW);
    });

    it("restores the cursor through the raw stderr descriptor while a render is active", () => {
      const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const writeSync = vi.spyOn(fs, "writeSync").mockImplementation(() => 1);

      const bar = createProgressBar({ label: "restore", total: 10, interactive: true });
      restoreTerminal();

      expect(writeSync).toHaveBeenCalledWith(2, `${"\r\u001b[2K"}${CURSOR_SHOW}`);
      restoreTerminal();
      expect(writeSync).toHaveBeenCalledTimes(1);
      bar.finish();
      expect(write).toHaveBeenCalledWith(CURSOR_SHOW);
    });

    it("performs no cursor writes for an injected stream", () => {
      const stream = makeStream();
      const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const files = makeClock();

      const bar = createProgressBar(barOptions({ stream, now: files.now, throttleMs: 1 }));
      files.advance(10);
      bar.update(1);
      bar.finish();

      expect(write).not.toHaveBeenCalled();
      expect(stream.text()).toContain(CURSOR_HIDE);
      expect(stream.text()).toContain(CURSOR_SHOW);
    });
  });
  describe("trackDownloadProgress", () => {
    it("passes chunks through and reports cumulative bytes (Issue #50)", async () => {
      async function* generate() {
        yield Buffer.from("chunk1");
        yield Buffer.from("chunk22");
      }
      const reported: number[] = [];
      const collected: Buffer[] = [];
      for await (const chunk of trackDownloadProgress(generate(), (bytes) =>
        reported.push(bytes),
      )) {
        collected.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(collected).toString()).toBe("chunk1chunk22");
      expect(reported).toEqual([6, 13]);
    });

    it("propagates stream failures (Issue #50)", async () => {
      async function* generate() {
        yield Buffer.from("partial");
        throw new Error("connection reset");
      }
      const reported: number[] = [];
      await expect(async () => {
        for await (const chunk of trackDownloadProgress(generate(), (bytes) =>
          reported.push(bytes),
        )) {
          void chunk;
        }
      }).rejects.toThrow("connection reset");
      expect(reported).toEqual([7]);
    });
  });
});
