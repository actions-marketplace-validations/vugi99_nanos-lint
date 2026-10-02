import { logger } from "./logger.js";

/** Writes command results to stdout unless the log level is `silent`. */
export function writeOutput(message: string): void {
  if (logger.isOutputEnabled()) {
    console.log(message);
  }
}
