import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPackageRoot } from "./config.js";
import { fileUriToPath } from "./types.js";
import type { CheckOptions, CheckResult, DiagnosticReport } from "./types.js";

const execFileAsync = promisify(execFile);

export const FALLBACK_LUALS_VERSION = "3.19.1";
export const DEFAULT_LUALS_VERSION = "latest";

/**
 * Escapes single quotes for safe PowerShell single-quoted string interpolation.
 */
export function escapePowerShellSingleQuote(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * Resolves the latest available LuaLS release tag from the GitHub API.
 */
export async function resolveLatestLuaLSVersion(): Promise<string> {
  try {
    const headers: Record<string, string> = { "User-Agent": "nanos-lint" };
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(
      "https://api.github.com/repos/LuaLS/lua-language-server/releases/latest",
      {
        headers,
        signal: AbortSignal.timeout(5000),
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      if (data.tag_name) {
        return data.tag_name.replace(/^v/, "");
      }
    }
  } catch {
    // Network error or rate limit fallback
  }
  return FALLBACK_LUALS_VERSION;
}

/**
 * Resolves a version string ("latest" -> actual tag).
 */
export async function resolveLuaLSVersion(version?: string): Promise<string> {
  if (!version || version === "latest") {
    return await resolveLatestLuaLSVersion();
  }
  return version.replace(/^v/, "");
}

export interface PlatformInfo {
  platform: "win32" | "linux" | "darwin";
  arch: "x64" | "arm64" | "ia32";
  assetName: string;
  binaryRelativePath: string;
}

export function getPlatformInfo(version: string = FALLBACK_LUALS_VERSION): PlatformInfo {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    if (arch === "x64") {
      return {
        platform: "win32",
        arch: "x64",
        assetName: `lua-language-server-${version}-win32-x64.zip`,
        binaryRelativePath: path.join("bin", "lua-language-server.exe"),
      };
    }
    throw new Error(`Unsupported Windows architecture: ${arch}. Supported: x64`);
  }

  if (platform === "linux") {
    if (arch === "x64") {
      return {
        platform: "linux",
        arch: "x64",
        assetName: `lua-language-server-${version}-linux-x64.tar.gz`,
        binaryRelativePath: path.join("bin", "lua-language-server"),
      };
    }
    if (arch === "arm64") {
      return {
        platform: "linux",
        arch: "arm64",
        assetName: `lua-language-server-${version}-linux-arm64.tar.gz`,
        binaryRelativePath: path.join("bin", "lua-language-server"),
      };
    }
    throw new Error(`Unsupported Linux architecture: ${arch}. Supported: x64, arm64`);
  }

  if (platform === "darwin") {
    const archName = arch === "arm64" ? "arm64" : "x64";
    return {
      platform: "darwin",
      arch: arch as "x64" | "arm64",
      assetName: `lua-language-server-${version}-darwin-${archName}.tar.gz`,
      binaryRelativePath: path.join("bin", "lua-language-server"),
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

export function getCacheDir(version: string = FALLBACK_LUALS_VERSION): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");

  return path.join(base, "nanos-lint", "luals", version);
}

export async function downloadAndExtractLuaLS(
  version: string = DEFAULT_LUALS_VERSION,
  targetDir?: string
): Promise<string> {
  const resolvedVersion = await resolveLuaLSVersion(version);
  const info = getPlatformInfo(resolvedVersion);
  const destDir = targetDir || getCacheDir(resolvedVersion);
  const binaryPath = path.join(destDir, info.binaryRelativePath);

  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  fs.mkdirSync(destDir, { recursive: true });

  const url = `https://github.com/LuaLS/lua-language-server/releases/download/${resolvedVersion}/${info.assetName}`;
  const archivePath = path.join(destDir, info.assetName);

  console.log(`[luals] Downloading LuaLS ${resolvedVersion} from ${url}...`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(archivePath, Buffer.from(arrayBuffer));

  console.log(`[luals] Extracting to ${destDir}...`);
  try {
    // Both Windows 10+ and UNIX systems have tar built in
    await execFileAsync("tar", ["-xf", archivePath, "-C", destDir]);
  } catch (tarErr) {
    // Fallback for PowerShell Expand-Archive on Windows if tar fails
    if (process.platform === "win32" && info.assetName.endsWith(".zip")) {
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${escapePowerShellSingleQuote(archivePath)}' -DestinationPath '${escapePowerShellSingleQuote(destDir)}' -Force`,
      ]);
    } else {
      throw tarErr;
    }
  }

  // Cleanup archive file
  try {
    fs.unlinkSync(archivePath);
  } catch {
    // Ignore cleanup error
  }

  // Make executable on unix
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch {
      // Ignore
    }
  }

  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Failed to extract LuaLS binary to expected path: ${binaryPath}`);
  }

  console.log(`[luals] Ready: ${binaryPath}`);
  return binaryPath;
}

export async function resolveLuaLSBinary(version: string = DEFAULT_LUALS_VERSION): Promise<string> {
  // 1. Explicit env var
  if (process.env.LUALS_BIN && fs.existsSync(process.env.LUALS_BIN)) {
    return process.env.LUALS_BIN;
  }

  const resolvedVersion = await resolveLuaLSVersion(version);
  const info = getPlatformInfo(resolvedVersion);

  // 2. Bundled with package (release distribution)
  const bundledPath = path.join(getPackageRoot(), info.binaryRelativePath);
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  // 3. User cache
  const cachedPath = path.join(getCacheDir(resolvedVersion), info.binaryRelativePath);
  if (fs.existsSync(cachedPath)) {
    return cachedPath;
  }

  // 4. In PATH
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(cmd, ["lua-language-server"]);
    const found = stdout.trim().split(/\r?\n/)[0];
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {
    // Not in PATH
  }

  // 5. Download and cache
  return await downloadAndExtractLuaLS(resolvedVersion);
}

export async function runLuaLSCheck(
  targetPath: string,
  configPath: string,
  options: CheckOptions
): Promise<CheckResult> {
  const binary = options.lualsBin || (await resolveLuaLSBinary(options.lualsVersion));

  const absoluteTarget = path.resolve(targetPath);
  let checkDir = absoluteTarget;
  let targetFileOnly: string | null = null;

  if (fs.existsSync(absoluteTarget) && fs.statSync(absoluteTarget).isFile()) {
    checkDir = path.dirname(absoluteTarget);
    targetFileOnly = absoluteTarget;
  }

  const tempOutputDir = path.join(os.tmpdir(), "nanos-lint");
  fs.mkdirSync(tempOutputDir, { recursive: true });
  const checkOutPath = path.join(
    tempOutputDir,
    `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );

  const args: string[] = [
    `--check=${checkDir}`,
    `--configpath=${path.resolve(configPath)}`,
    `--check_out_path=${checkOutPath}`,
    "--check_format=json",
  ];

  if (options.checklevel) {
    args.push(`--checklevel=${options.checklevel}`);
  }

  try {
    await execFileAsync(binary, args, {
      maxBuffer: 100 * 1024 * 1024,
    });
  } catch {
    // Process may exit with non-zero when diagnostics are found
  }

  let diagnostics: DiagnosticReport = {};
  if (fs.existsSync(checkOutPath)) {
    try {
      const content = fs.readFileSync(checkOutPath, "utf-8");
      diagnostics = JSON.parse(content) as DiagnosticReport;
    } catch {
      // Failed to parse json
    } finally {
      try {
        fs.unlinkSync(checkOutPath);
      } catch {
        // Ignore unlink error
      }
    }
  }

  // If a single file was requested, filter diagnostics to only that file
  if (targetFileOnly) {
    const filtered: DiagnosticReport = {};
    const normTarget = path.resolve(targetFileOnly).toLowerCase();
    for (const [rawUri, diags] of Object.entries(diagnostics)) {
      const filePath = fileUriToPath(rawUri);
      if (path.resolve(filePath).toLowerCase() === normTarget) {
        filtered[rawUri] = diags;
      }
    }
    diagnostics = filtered;
  }

  let totalProblems = 0;
  let totalFiles = 0;

  for (const [_, diags] of Object.entries(diagnostics)) {
    if (diags.length > 0) {
      totalFiles += 1;
      totalProblems += diags.length;
    }
  }

  const passed = totalProblems === 0;

  return {
    passed,
    totalProblems,
    totalFiles,
    diagnostics,
    outputPath: checkOutPath,
  };
}
