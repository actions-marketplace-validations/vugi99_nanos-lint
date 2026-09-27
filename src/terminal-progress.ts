import fs from "node:fs";
import { logger } from "./logger.js";
import { formatBytes } from "./paths.js";

/** Minimum delay between two terminal redraws (about ten frames per second). */
export const PROGRESS_THROTTLE_MS = 100;
/** Braille frames cycled while an indeterminate operation runs. */
export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Fractions of a transfer logged as milestones when no terminal can be redrawn. */
export const PROGRESS_MILESTONES: readonly number[] = [0.25, 0.5, 0.75];

/** Redraw policy: `auto` follows terminal detection, `off` forces log milestones. */
export type ProgressMode = "auto" | "off";

/** Terminal stream receiving progress frames, mirroring the parts of `tty.WriteStream` used. */
export interface ProgressStream {
  write(chunk: string): unknown;
  columns?: number | undefined;
  isTTY?: boolean | undefined;
}

/** Options shared by progress bars and spinners. */
export interface ProgressOptions {
  label: string;
  total?: number | undefined;
  stream?: ProgressStream | undefined;
  interactive?: boolean | undefined;
  announce?: boolean | undefined;
  now?: (() => number) | undefined;
  throttleMs?: number | undefined;
}

export type ProgressBarOptions = ProgressOptions;

/** Handle to a running byte progress bar. */
export interface ProgressBarHandle {
  update(transferred: number, total?: number): void;
  finish(message?: string): void;
  fail(message?: string): void;
}

/** Handle to a running indeterminate spinner. */
export interface SpinnerHandle {
  start(): void;
  tick(): void;
  updateText(label: string): void;
  stop(message?: string): void;
  fail(message?: string): void;
}

const CURSOR_HIDE = "\u001b[?25l";
const CURSOR_SHOW = "\u001b[?25h";
const CLEAR_LINE = "\r\u001b[2K";
const FRAME_TAIL = "  ";
const DEFAULT_COLUMNS = 80;
const MIN_BAR_WIDTH = 8;
const MAX_BAR_WIDTH = 28;
const TRUNCATION = "...";

interface RenderState {
  stream: ProgressStream;
  interactive: boolean;
  ownsProcessStderr: boolean;
  label: string;
  now: () => number;
  throttleMs: number;
  startedAt: number;
  lastFrameAt: number;
  active: boolean;
}

let progressMode: ProgressMode = "auto";
let cursorHidden = false;
let guardsInstalled = false;
let activeDynamicRenders = 0;

/** Sets the redraw policy used by every progress display created afterwards. */
export function setProgressMode(mode: ProgressMode): void {
  progressMode = mode;
}

/** Returns the current redraw policy. */
export function getProgressMode(): ProgressMode {
  return progressMode;
}

/** Returns whether an environment value is set to anything but an explicit false. */
function isEnvFlagSet(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized !== "" &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "no" &&
    normalized !== "off"
  );
}

/**
 * Returns whether dynamic redrawing is allowed for the given environment and terminal.
 * Non-interactive environments get single-line milestones instead of carriage returns.
 */
export function isProgressInteractive(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean | undefined = process.stderr.isTTY,
): boolean {
  if (progressMode === "off" || !logger.isOutputEnabled() || !isTTY) {
    return false;
  }
  if ((env.TERM ?? "").trim().toLowerCase() === "dumb") {
    return false;
  }
  return !(
    isEnvFlagSet(env.CI) ||
    isEnvFlagSet(env.NO_COLOR) ||
    isEnvFlagSet(env.NANOS_NO_PROGRESS)
  );
}

/** Writes a control sequence straight to file descriptor 2, tolerating a closed stderr. */
function writeToStderr(sequence: string): void {
  try {
    fs.writeSync(2, sequence);
  } catch (err) {
    void err;
  }
}

/** Restores the cursor and abandons the active progress line; safe to call at any time. */
export function restoreTerminal(): void {
  if (!cursorHidden) {
    return;
  }
  cursorHidden = false;
  writeToStderr(`${CLEAR_LINE}${CURSOR_SHOW}`);
}

/** Restores the cursor, then re-raises the signal with the default disposition. */
function handleTerminationSignal(signal: NodeJS.Signals): void {
  restoreTerminal();
  removeTerminalGuards();
  process.kill(process.pid, signal);
}

/** Installs exit, crash and signal hooks so a hidden cursor is always restored. */
function installTerminalGuards(): void {
  if (guardsInstalled) {
    return;
  }
  guardsInstalled = true;
  process.on("exit", restoreTerminal);
  process.on("uncaughtExceptionMonitor", restoreTerminal);
  process.on("SIGINT", handleTerminationSignal);
  process.on("SIGTERM", handleTerminationSignal);
}

/** Removes the cursor guards once no dynamic render is active. */
function removeTerminalGuards(): void {
  if (!guardsInstalled) {
    return;
  }
  guardsInstalled = false;
  process.off("exit", restoreTerminal);
  process.off("uncaughtExceptionMonitor", restoreTerminal);
  process.off("SIGINT", handleTerminationSignal);
  process.off("SIGTERM", handleTerminationSignal);
}

/** Builds the mutable rendering state shared by bars and spinners. */
function createRenderState(options: ProgressOptions): RenderState {
  const stream = options.stream ?? process.stderr;
  const now = options.now ?? Date.now;
  return {
    stream,
    interactive: options.interactive ?? isProgressInteractive(process.env, stream.isTTY),
    ownsProcessStderr: options.stream === undefined,
    label: options.label,
    now,
    throttleMs: Math.max(1, options.throttleMs ?? PROGRESS_THROTTLE_MS),
    startedAt: now(),
    lastFrameAt: Number.NEGATIVE_INFINITY,
    active: false,
  };
}

/** Truncates a frame so it never wraps onto a second terminal line. */
function fitToWidth(state: RenderState, line: string): string {
  const limit = Math.max(1, (state.stream.columns ?? DEFAULT_COLUMNS) - 1);
  if (line.length <= limit) {
    return line;
  }
  if (limit <= TRUNCATION.length) {
    return TRUNCATION.slice(0, limit);
  }
  return `${line.slice(0, limit - TRUNCATION.length)}${TRUNCATION}`;
}

/** Hides the cursor and arms the exit guards when a dynamic render starts. */
function beginFrame(state: RenderState): void {
  if (state.active) {
    return;
  }
  state.active = true;
  if (!state.ownsProcessStderr) {
    state.stream.write(CURSOR_HIDE);
    return;
  }
  activeDynamicRenders += 1;
  if (activeDynamicRenders > 1) {
    return;
  }
  cursorHidden = true;
  installTerminalGuards();
  state.stream.write(CURSOR_HIDE);
}

/** Clears the dynamic line and reveals the cursor once the render stops. */
function endFrame(state: RenderState): void {
  if (!state.interactive || !state.active) {
    return;
  }
  state.active = false;
  state.stream.write(CLEAR_LINE);
  if (!state.ownsProcessStderr) {
    state.stream.write(CURSOR_SHOW);
    return;
  }
  activeDynamicRenders = Math.max(0, activeDynamicRenders - 1);
  if (activeDynamicRenders === 0) {
    cursorHidden = false;
    removeTerminalGuards();
    state.stream.write(CURSOR_SHOW);
  }
}

/** Draws one frame, throttled unless `force`d, replacing whatever the line held. */
function drawFrame(state: RenderState, line: string, force = false): void {
  if (!state.interactive) {
    return;
  }
  const now = state.now();
  if (!force && now - state.lastFrameAt < state.throttleMs) {
    return;
  }
  state.lastFrameAt = now;
  beginFrame(state);
  state.stream.write(`${CLEAR_LINE}${fitToWidth(state, line)}${FRAME_TAIL}`);
}

/** Formats a duration in milliseconds as seconds. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** Formats a completed transfer as size, duration and average speed. */
export function formatTransferSummary(bytes: number, elapsedMs: number): string {
  const elapsed = Math.max(elapsedMs, 1);
  return `${formatBytes(bytes)} in ${formatDuration(elapsed)} (${formatBytes(bytes / (elapsed / 1000))}/s)`;
}

/** Builds the `[====>   ]` fill for a completion ratio. */
function buildBar(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  if (filled >= width) {
    return "=".repeat(width);
  }
  return `${"=".repeat(filled)}>${" ".repeat(width - filled - 1)}`;
}

/** Picks a bar width that keeps the whole frame inside the terminal. */
function barWidthFor(state: RenderState, reserved: number): number {
  const columns = state.stream.columns ?? DEFAULT_COLUMNS;
  return Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, columns - reserved));
}

/** Renders one deterministic transfer frame. */
function renderBarFrame(state: RenderState, transferred: number, total?: number): string {
  const elapsedMs = state.now() - state.startedAt;
  const speed = transferred / (Math.max(elapsedMs, 1) / 1000);
  const speedText = `${formatBytes(speed)}/s`;
  if (!total || total <= 0) {
    return `${state.label} ${formatBytes(transferred)} (${speedText}, ${formatDuration(elapsedMs)})`;
  }
  const ratio = Math.max(0, Math.min(1, transferred / total));
  const percent = Math.floor(ratio * 100);
  const eta =
    speed > 0 && transferred < total
      ? `, ETA ${formatDuration(((total - transferred) / speed) * 1000)}`
      : "";
  const tail = ` ${percent}% (${formatBytes(transferred)} / ${formatBytes(total)}, ${speedText}${eta})`;
  const width = barWidthFor(state, state.label.length + tail.length + FRAME_TAIL.length + 4);
  return `${state.label} [${buildBar(ratio, width)}]${tail}`;
}

/** Renders one indeterminate spinner frame. */
function renderSpinnerFrame(state: RenderState, frame: number): string {
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "|";
  return `${state.label} ${glyph} (${formatDuration(state.now() - state.startedAt)})`;
}

/** Creates a byte progress bar; without a terminal it logs start, milestones and completion. */
export function createProgressBar(options: ProgressBarOptions): ProgressBarHandle {
  const state = createRenderState(options);
  let transferred = 0;
  let total = options.total !== undefined && options.total > 0 ? options.total : undefined;
  let milestone = 0;

  if (!state.interactive && options.announce !== false) {
    logger.info(`${state.label}${total ? ` (${formatBytes(total)})` : ""}...`);
  }
  if (state.interactive) {
    drawFrame(state, renderBarFrame(state, 0, total), true);
  }

  const settle = (message: string | undefined, level: "info" | "warn"): void => {
    endFrame(state);
    if (message) {
      logger[level](message);
    }
  };

  return {
    update: (next: number, nextTotal?: number): void => {
      transferred = Math.max(transferred, next);
      if (nextTotal !== undefined && nextTotal > 0) {
        total = nextTotal;
      }
      // A transport can declare a compressed length (gzip) and then stream more bytes than
      // that, so a total the transfer has already passed is dropped rather than misreported.
      if (total !== undefined && transferred > total) {
        total = undefined;
      }
      if (state.interactive) {
        drawFrame(state, renderBarFrame(state, transferred, total));
        return;
      }
      if (!total) {
        return;
      }
      const ratio = transferred / total;
      while (
        milestone < PROGRESS_MILESTONES.length &&
        ratio >= (PROGRESS_MILESTONES[milestone] ?? 1)
      ) {
        const reached = PROGRESS_MILESTONES[milestone] ?? 1;
        milestone += 1;
        logger.info(
          `${state.label}: ${Math.round(reached * 100)}% (${formatBytes(transferred)} / ${formatBytes(total)})`,
        );
      }
    },
    finish: (message?: string): void => settle(message, "info"),
    fail: (message?: string): void => settle(message, "warn"),
  };
}

/** Creates an indeterminate spinner driven by a timer and by manual ticks from sync loops. */
export function createSpinner(options: ProgressOptions): SpinnerHandle {
  const state = createRenderState(options);
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const settle = (message: string | undefined, level: "info" | "warn"): void => {
    clearTimer();
    endFrame(state);
    if (message) {
      logger[level](message);
    }
  };

  return {
    start: (): void => {
      if (!state.interactive) {
        if (options.announce !== false) {
          logger.info(`${state.label}...`);
        }
        return;
      }
      drawFrame(state, renderSpinnerFrame(state, frame), true);
      if (timer === undefined) {
        timer = setInterval(() => {
          frame += 1;
          drawFrame(state, renderSpinnerFrame(state, frame), true);
        }, state.throttleMs);
        timer.unref();
      }
    },
    tick: (): void => {
      frame += 1;
      drawFrame(state, renderSpinnerFrame(state, frame));
    },
    updateText: (label: string): void => {
      state.label = label;
      drawFrame(state, renderSpinnerFrame(state, frame), true);
    },
    stop: (message?: string): void => settle(message, "info"),
    fail: (message?: string): void => settle(message, "warn"),
  };
}
