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

/** Validates whether a string corresponds to a recognized log level. */
export function isValidLogLevel(level: string): level is LogLevel {
  return level in LOG_LEVEL_PRIORITY;
}

/** Parses a string into a valid LogLevel, defaulting to 'warn'. */
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
      const envLevel = process.env.NANOS_LOG_LEVEL;
      if (envLevel && isValidLogLevel(envLevel.trim().toLowerCase())) {
        this.level = envLevel.trim().toLowerCase() as LogLevel;
      }
    }
  }

  /** Sets the active minimum logging level. */
  public setLevel(level: LogLevel): void {
    if (isValidLogLevel(level)) {
      this.level = level;
    }
  }

  /** Returns the current active log level. */
  public getLevel(): LogLevel {
    return this.level;
  }

  /** Checks if a message at the specified level should be emitted. */
  public isEnabledFor(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[this.level] >= LOG_LEVEL_PRIORITY[level];
  }

  /** Whether command results should be written; only `silent` disables them. */
  public isOutputEnabled(): boolean {
    return this.level !== "silent";
  }

  /** Logs an error-level message to stderr. */
  public error(...args: unknown[]): void {
    if (this.isEnabledFor("error")) {
      console.error(...args);
    }
  }

  /** Logs a warning-level message to stderr. */
  public warn(...args: unknown[]): void {
    if (this.isEnabledFor("warn")) {
      console.warn(...args);
    }
  }

  /** Logs an informational message to stdout. */
  public info(...args: unknown[]): void {
    if (this.isEnabledFor("info")) {
      console.log(...args);
    }
  }

  /** Logs a debug-level diagnostic message to stdout. */
  public debug(...args: unknown[]): void {
    if (this.isEnabledFor("debug")) {
      console.debug(...args);
    }
  }
}

export const logger = new Logger();

export default logger;
