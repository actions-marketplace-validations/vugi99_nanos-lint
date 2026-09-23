export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export const LOG_LEVELS: ReadonlyArray<LogLevel> = [
  "silent",
  "error",
  "warn",
  "info",
  "debug",
] as const;

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export const DEFAULT_LOG_LEVEL: LogLevel = "warn";

export function isValidLogLevel(level: string): level is LogLevel {
  return level in LOG_LEVEL_PRIORITY;
}

export function parseLogLevel(raw?: string | null): LogLevel {
  if (!raw) return DEFAULT_LOG_LEVEL;
  const lower = raw.trim().toLowerCase();
  return isValidLogLevel(lower) ? lower : DEFAULT_LOG_LEVEL;
}

export class Logger {
  private level: LogLevel = DEFAULT_LOG_LEVEL;

  constructor(initialLevel?: LogLevel) {
    if (initialLevel && isValidLogLevel(initialLevel)) {
      this.level = initialLevel;
    } else {
      // Only the namespaced variable is honored: a bare LOG_LEVEL is commonly
      // set by CI images and unrelated tooling, so it must not silently change
      // nanos-lint's verbosity.
      const envLevel = process.env.NANOS_LOG_LEVEL;
      if (envLevel && isValidLogLevel(envLevel.trim().toLowerCase())) {
        this.level = envLevel.trim().toLowerCase() as LogLevel;
      }
    }
  }

  public setLevel(level: LogLevel): void {
    if (isValidLogLevel(level)) {
      this.level = level;
    }
  }

  public getLevel(): LogLevel {
    return this.level;
  }

  public isEnabledFor(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[this.level] >= LOG_LEVEL_PRIORITY[level];
  }

  /**
   * Whether command results (the diagnosis report, `init`/`clean-cache`
   * confirmations, ...) should be written to stdout. Only `silent` disables
   * them, so `--quiet`/`--log-level=error` still print the report while
   * suppressing progress messages.
   */
  public isOutputEnabled(): boolean {
    return this.level !== "silent";
  }

  public error(...args: unknown[]): void {
    if (this.isEnabledFor("error")) {
      console.error(...args);
    }
  }

  public warn(...args: unknown[]): void {
    if (this.isEnabledFor("warn")) {
      console.warn(...args);
    }
  }

  public info(...args: unknown[]): void {
    if (this.isEnabledFor("info")) {
      console.log(...args);
    }
  }

  public debug(...args: unknown[]): void {
    if (this.isEnabledFor("debug")) {
      console.debug(...args);
    }
  }
}

export const logger = new Logger();

export default logger;
