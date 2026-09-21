#!/usr/bin/env node
import { runCLI } from "../dist/cli.js";

runCLI()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

