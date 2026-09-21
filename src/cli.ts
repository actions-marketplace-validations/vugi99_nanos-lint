import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceConfig, initWorkspace, getPackageRoot } from "./config.js";
import { runLuaLSCheck, resolveLuaLSBinary, DEFAULT_LUALS_VERSION } from "./luals.js";
import { formatReport } from "./reporter.js";
import type { CheckOptions, DiagnosticSeverity } from "./types.js";

function printHelp(): void {
  console.log(`
nanos-lint - Linter and type-checker for nanos world Lua scripts

USAGE:
  nanos-lint [command] [options] [path]

COMMANDS:
  check [path]             Check a workspace or Lua file (default command)
  init [path]              Scaffold a .luarc.json configuration in the workspace
  download-luals [version] Download and cache the LuaLS binary
  help, --help, -h         Show this help message
  version, --version, -v   Show version information

OPTIONS:
  --checklevel=<level>     Minimum diagnostic level: Error, Warning, Information, Hint (default: Warning)
  --config=<path>          Path to custom .luarc.json configuration file
  --format=<format>        Output format: pretty, json, github (default: pretty, auto-detects GitHub Actions)
  --luals-version=<ver>    Version of LuaLS to use (default: ${DEFAULT_LUALS_VERSION})
  --no-fail                Do not exit with code 1 if diagnostics are found
  --quiet                  Suppress progress output

EXAMPLES:
  npx nanos-lint
  npx nanos-lint check ./my-package
  npx nanos-lint check . --checklevel=Error
  npx nanos-lint init
`);
}

function printVersion(): void {
  const root = getPackageRoot();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    console.log(`nanos-lint v${pkg.version}`);
  } catch {
    console.log("nanos-lint v1.0.0");
  }
}

export async function runCLI(args: string[] = process.argv.slice(2)): Promise<number> {
  let command = "check";
  let targetPath = ".";
  const options: CheckOptions = {
    path: ".",
    format: process.env.GITHUB_ACTIONS ? "github" : "pretty",
    failOnError: true,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h" || arg === "help") {
      printHelp();
      return 0;
    }

    if (arg === "--version" || arg === "-v" || arg === "version") {
      printVersion();
      return 0;
    }

    if (arg === "--no-fail") {
      options.failOnError = false;
      continue;
    }

    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }

    if (arg.startsWith("--checklevel=")) {
      options.checklevel = arg.split("=")[1] as DiagnosticSeverity;
      continue;
    }

    if (arg === "--checklevel") {
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        options.checklevel = args[++i] as DiagnosticSeverity;
      } else {
        console.warn("[nanos-lint] Warning: Option '--checklevel' requires a value");
      }
      continue;
    }

    if (arg.startsWith("--config=")) {
      options.configpath = arg.split("=")[1];
      continue;
    }

    if (arg === "--config") {
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        options.configpath = args[++i];
      } else {
        console.warn("[nanos-lint] Warning: Option '--config' requires a value");
      }
      continue;
    }

    if (arg.startsWith("--format=")) {
      options.format = arg.split("=")[1] as "pretty" | "json" | "github";
      continue;
    }

    if (arg === "--format") {
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        options.format = args[++i] as "pretty" | "json" | "github";
      } else {
        console.warn("[nanos-lint] Warning: Option '--format' requires a value");
      }
      continue;
    }

    if (arg.startsWith("--luals-version=")) {
      options.lualsVersion = arg.split("=")[1];
      continue;
    }

    if (arg === "--luals-version") {
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        options.lualsVersion = args[++i];
      } else {
        console.warn("[nanos-lint] Warning: Option '--luals-version' requires a value");
      }
      continue;
    }

    if (arg === "--github") {
      options.format = "github";
      continue;
    }

    if (arg.startsWith("-")) {
      console.warn(`[nanos-lint] Warning: Unrecognized option '${arg}'`);
      continue;
    }

    positional.push(arg);
  }

  if (positional.length > 0) {
    const first = positional[0];
    if (first === "check" || first === "init" || first === "download-luals") {
      command = first;
      targetPath = positional[1] || ".";
    } else {
      targetPath = first;
    }
  }

  options.path = targetPath;

  if (command === "init") {
    const created = initWorkspace(path.resolve(targetPath));
    console.log(`[init] Initialized nanos world LuaLS configuration: ${created}`);
    return 0;
  }

  if (command === "download-luals") {
    const ver = positional[1] || options.lualsVersion || DEFAULT_LUALS_VERSION;
    console.log(`[luals] Downloading LuaLS ${ver}...`);
    const bin = await resolveLuaLSBinary(ver);
    console.log(`[luals] Ready at: ${bin}`);
    return 0;
  }

  // Run Check
  const resolved = resolveWorkspaceConfig(targetPath, options.configpath);
  let result;
  try {
    result = await runLuaLSCheck(targetPath, resolved.configPath, options);
  } finally {
    if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
      try {
        fs.unlinkSync(resolved.configPath);
      } catch {
        // Ignore temp file cleanup error
      }
    }
  }

  const output = formatReport(result, options.format, process.cwd());
  if (output) {
    console.log(output);
  }

  if (!result.passed && options.failOnError) {
    return 1;
  }

  return 0;
}

