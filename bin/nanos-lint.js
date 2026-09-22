#!/usr/bin/env node
import { runCLI } from "../dist/cli.js";

runCLI()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    if (process.env.DEBUG && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });


