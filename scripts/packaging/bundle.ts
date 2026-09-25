import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { getTarBinary } from "../../src/luals/validation.js";
import type { PackageTargetConfig, TargetOs } from "./types.js";

const execFileAsync = promisify(execFile);

export function createLauncher(pkgDir: string, os: TargetOs): string {
  if (os === "windows") {
    const launcherPath = path.join(pkgDir, "nanos-lint.cmd");
    const content = `@echo off\r\nnode "%~dp0dist\\cli.js" %*\r\nexit /b %ERRORLEVEL%\r\n`;
    fs.writeFileSync(launcherPath, content, "utf-8");
    return launcherPath;
  }

  const launcherPath = path.join(pkgDir, "nanos-lint");
  const content = `#!/usr/bin/env bash\nDIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\nexec node "$DIR/dist/cli.js" "$@"\n`;
  fs.writeFileSync(launcherPath, content, { encoding: "utf-8", mode: 0o755 });
  try {
    fs.chmodSync(launcherPath, 0o755);
  } catch (err) {
    void err;
  }
  return launcherPath;
}

export interface AssembleOptions {
  pkgDir: string;
  extractedLualsDir: string;
  target: PackageTargetConfig;
  annotationsPath: string;
  repoRoot: string;
}

export function assemblePackageDir(options: AssembleOptions): void {
  const { pkgDir, extractedLualsDir, target, annotationsPath, repoRoot } = options;

  if (fs.existsSync(pkgDir)) {
    fs.rmSync(pkgDir, { recursive: true, force: true });
  }

  fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, "templates"), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });

  const binSrc = path.join(extractedLualsDir, "bin");
  if (fs.existsSync(binSrc)) {
    fs.cpSync(binSrc, path.join(pkgDir, "bin"), { recursive: true });
  }

  for (const item of ["locale", "meta", "script", "main.lua"]) {
    const src = path.join(extractedLualsDir, item);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(pkgDir, item), { recursive: true });
    }
  }

  fs.cpSync(path.join(repoRoot, "dist"), path.join(pkgDir, "dist"), { recursive: true });
  fs.copyFileSync(annotationsPath, path.join(pkgDir, "annotations.lua"));
  fs.cpSync(path.join(repoRoot, "templates"), path.join(pkgDir, "templates"), { recursive: true });

  for (const doc of ["package.json", "README.md", "LICENSE"]) {
    const docPath = path.join(repoRoot, doc);
    if (fs.existsSync(docPath)) {
      fs.copyFileSync(docPath, path.join(pkgDir, doc));
    }
  }

  createLauncher(pkgDir, target.os);

  execFileSync(process.execPath, [path.join(pkgDir, "dist", "cli.js"), "--help"], {
    stdio: "pipe",
  });

  if (process.platform === "linux" && target.id === "linux-x64") {
    const launcher = path.join(pkgDir, "nanos-lint");
    execFileSync(launcher, ["--help"], { stdio: "pipe" });
  }
}

export async function createReleaseArchive(
  pkgDir: string,
  outputFile: string,
  format: "zip" | "tar.gz",
): Promise<void> {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const resolvedOut = path.resolve(outputFile);

  if (fs.existsSync(resolvedOut)) {
    fs.unlinkSync(resolvedOut);
  }

  if (format === "zip") {
    if (process.platform === "win32") {
      try {
        await execFileAsync(getTarBinary(), ["-acf", resolvedOut, "."], { cwd: pkgDir });
      } catch {
        await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path '${pkgDir}\\*' -DestinationPath '${resolvedOut}' -Force`,
        ]);
      }
    } else {
      await execFileAsync("zip", ["-rq", resolvedOut, "."], { cwd: pkgDir });
    }
  } else {
    const tarBin = process.platform === "win32" ? getTarBinary() : "tar";
    await execFileAsync(tarBin, ["-czf", resolvedOut, "-C", pkgDir, "."]);
  }

  if (!fs.existsSync(resolvedOut) || fs.statSync(resolvedOut).size === 0) {
    throw new Error(`Failed to create release archive or output is empty: ${resolvedOut}`);
  }
}
