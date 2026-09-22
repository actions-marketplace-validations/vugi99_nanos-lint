import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import { resolveWorkspaceConfig, initWorkspace, getPackageRoot } from "./config.js";
import { resolveAnnotations } from "./annotations.js";
import { runLuaLSCheck, resolveLuaLSBinary, DEFAULT_LUALS_VERSION } from "./luals.js";
import { cleanCache, systemPaths } from "./paths.js";
import { formatReport } from "./reporter.js";
import type { CheckOptions, DiagnosticSeverity } from "./types.js";

function getVersionString(): string {
  const root = getPackageRoot();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    return `nanos-lint v${pkg.version}`;
  } catch {
    return "nanos-lint v1.0.0";
  }
}

export function collectIgnorePatterns(val: string, prev?: string[]): string[] {
  const parts = val
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (prev ?? []).concat(parts);
}

interface CheckCommandOptions {
  checklevel: DiagnosticSeverity;
  config?: string;
  annotations?: string;
  format?: "pretty" | "json" | "github";
  lualsVersion: string;
  fail: boolean;
  quiet?: boolean;
  github?: boolean;
  ignore?: string[];
}

export interface CreateProgramOptions {
  setExitCode?: (code: number) => void;
}

export function createProgram(options?: CreateProgramOptions): Command {
  const setExitCode = options?.setExitCode ?? (() => {});
  const program = new Command("nanos-lint");

  program
    .description("Linter and type-checker for nanos world Lua scripts")
    .version(getVersionString(), "-v, --version", "Show version information")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => console.log(str.trimEnd()),
      writeErr: (str) => console.error(str.trimEnd()),
    });

  program
    .command("check [path]", { isDefault: true })
    .description("Check a workspace or Lua file (default command)")
    .addOption(
      new Option(
        "--checklevel <level>",
        "Minimum diagnostic level: Error, Warning, Information, Hint"
      )
        .choices(["Error", "Warning", "Information", "Hint"])
        .default("Warning")
    )
    .option("--config <path>", "Path to custom .luarc.json configuration file")
    .option("--annotations <path>", "Path to custom annotations.lua file")
    .addOption(
      new Option(
        "--format <format>",
        "Output format: pretty, json, github (default: pretty, auto-detects GitHub Actions)"
      ).choices(["pretty", "json", "github"])
    )
    .option(
      "-i, --ignore <pattern>",
      "Files or directories to ignore (supports glob patterns, repeatable)",
      collectIgnorePatterns
    )
    .option("--luals-version <ver>", `Version of LuaLS to use (default: ${DEFAULT_LUALS_VERSION})`, DEFAULT_LUALS_VERSION)
    .option("--no-fail", "Do not exit with code 1 if diagnostics are found")
    .option("--quiet", "Suppress progress output")
    .option("--github", "Output in GitHub Actions format (shortcut for --format=github)")
    .action(async (targetPath: string = ".", opts: CheckCommandOptions) => {
      const format = opts.github
        ? "github"
        : opts.format || (process.env.GITHUB_ACTIONS ? "github" : "pretty");

      const checkOptions: CheckOptions = {
        path: targetPath,
        configpath: opts.config,
        checklevel: opts.checklevel,
        format,
        lualsVersion: opts.lualsVersion,
        failOnError: opts.fail !== false,
        quiet: opts.quiet,
        ignore: opts.ignore,
      };

      const annotationsPath = await resolveAnnotations({
        customPath: opts.annotations,
        quiet: opts.quiet,
      });

      const resolved = resolveWorkspaceConfig(targetPath, checkOptions.configpath, {
        ignore: checkOptions.ignore,
        annotationsPath,
      });
      let result;
      try {
        result = await runLuaLSCheck(targetPath, resolved.configPath, checkOptions);
      } finally {
        if (resolved.isTemp && fs.existsSync(resolved.configPath)) {
          try {
            fs.unlinkSync(resolved.configPath);
          } catch {
            // Ignore temp file cleanup error
          }
        }
      }

      const output = formatReport(result, checkOptions.format, process.cwd());
      if (output) {
        console.log(output);
      }

      if (!result.passed && checkOptions.failOnError) {
        setExitCode(1);
      } else {
        setExitCode(0);
      }
    });

  program
    .command("init [path]")
    .description("Scaffold a .luarc.json configuration in the workspace")
    .option("-f, --force", "Overwrite existing .luarc.json configuration")
    .option("--annotations <path>", "Path to custom annotations.lua file")
    .action(async (targetPath: string = ".", opts: { force?: boolean; annotations?: string }) => {
      const annotationsPath = await resolveAnnotations({
        customPath: opts.annotations,
      });
      const created = initWorkspace(path.resolve(targetPath), {
        force: opts.force,
        annotationsPath,
      });
      console.log(`[init] Initialized nanos world LuaLS configuration: ${created}`);
      setExitCode(0);
    });

  program
    .command("download-luals [version]")
    .description("Download and cache the LuaLS binary")
    .option("--luals-version <ver>", `Version of LuaLS to use (default: ${DEFAULT_LUALS_VERSION})`)
    .action(async (version?: string, opts?: { lualsVersion?: string }) => {
      const ver = version || opts?.lualsVersion || DEFAULT_LUALS_VERSION;
      console.log(`[luals] Downloading LuaLS ${ver}...`);
      const bin = await resolveLuaLSBinary(ver);
      console.log(`[luals] Ready at: ${bin}`);
      setExitCode(0);
    });

  program
    .command("clean-cache")
    .alias("clean")
    .description("Clear the nanos-lint cache")
    .action(() => {
      try {
        const cleared = cleanCache();
        if (cleared) {
          console.log(`[cache] Cleared cache at: ${cleared}`);
        } else {
          console.log(`[cache] Cache is already empty (${systemPaths.cache})`);
        }
        setExitCode(0);
      } catch (err) {
        console.error(
          `[cache] Failed to clear cache: ${err instanceof Error ? err.message : String(err)}`
        );
        setExitCode(1);
      }
    });

  program
    .command("version")
    .description("Show version information")
    .action(() => {
      console.log(getVersionString());
      setExitCode(0);
    });

  program.helpCommand("help [command]", "Show this help message");

  program.addHelpText(
    "after",
    `
Examples:
  $ npx nanos-lint
  $ npx nanos-lint check ./my-package
  $ npx nanos-lint check . --checklevel=Error
  $ npx nanos-lint check . --ignore "myfolder/hello-*.lua"
  $ npx nanos-lint init
  $ npx nanos-lint clean-cache
`
  );

  return program;
}

export async function runCLI(args: string[] = process.argv.slice(2)): Promise<number> {
  let exitCode = 0;
  const program = createProgram({
    setExitCode: (code) => {
      exitCode = code;
    },
  });

  try {
    await program.parseAsync(args, { from: "user" });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    if (process.env.DEBUG && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return 1;
  }
}

export function isDirectExecution(
  importMetaUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1]
): boolean {
  if (!argv1) {
    return false;
  }
  const toPath = (urlStr: string): string => {
    try {
      if (urlStr.startsWith("file:")) {
        return fileURLToPath(urlStr);
      }
      return urlStr;
    } catch {
      return urlStr.replace(/^file:\/\/\/?/, "");
    }
  };

  try {
    const scriptPath = fs.realpathSync(path.resolve(argv1)).toLowerCase();
    const modulePath = fs.realpathSync(toPath(importMetaUrl)).toLowerCase();
    if (scriptPath === modulePath) {
      return true;
    }
    const moduleDir = path.dirname(modulePath);
    const cliJsPath = path.join(moduleDir, "cli.js").toLowerCase();
    const cliTsPath = path.join(moduleDir, "cli.ts").toLowerCase();
    if (scriptPath === cliJsPath || scriptPath === cliTsPath) {
      return true;
    }
  } catch {
    const normArgv = path.resolve(argv1).toLowerCase();
    const normMeta = toPath(importMetaUrl).toLowerCase();
    if (normArgv === normMeta) {
      return true;
    }
    const normDir = path.dirname(normMeta);
    if (
      normArgv === path.join(normDir, "cli.js").toLowerCase() ||
      normArgv === path.join(normDir, "cli.ts").toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

if (isDirectExecution()) {
  runCLI()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
