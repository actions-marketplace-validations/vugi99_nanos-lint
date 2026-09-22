import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { getPackageRoot } from "./config.js";
import { systemPaths } from "./paths.js";
import { fileUriToPath } from "./types.js";
import type { CheckOptions, CheckResult, DiagnosticReport, LuaRCConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export const FALLBACK_LUALS_VERSION = "3.19.1";
export const DEFAULT_LUALS_VERSION = "latest";

/**
 * Characters accepted in a LuaLS version/tag. Only ASCII letters, digits, dots,
 * dashes and underscores are allowed, so a version can never contain a path
 * separator, a drive letter or a traversal segment.
 */
const SAFE_VERSION_CHARS: ReadonlyMap<string, string> = new Map(
  [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._-"].map((ch) => [ch, ch])
);

const MAX_VERSION_LENGTH = 64;

/**
 * Validates a LuaLS version/tag and rebuilds it from the allow-list above.
 *
 * Version strings originate from untrusted sources: the GitHub releases API
 * response and user supplied `--luals-version` arguments. They are interpolated
 * into cache directory paths, download URLs, and the path of the binary that is
 * eventually executed, so they must be constrained to a single safe path
 * segment. Rebuilding the value character by character guarantees the returned
 * string only ever contains allow-listed characters (CodeQL: js/command-line-injection).
 *
 * @returns the normalized version (a single leading `v` is dropped), or `null`
 *          when the input cannot be used as a version tag.
 */
export function sanitizeLuaLSVersion(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) {
    return null;
  }

  let version = "";
  for (const ch of trimmed) {
    const allowed = SAFE_VERSION_CHARS.get(ch);
    if (allowed === undefined) {
      return null;
    }
    version += allowed;
  }

  // Drop a single leading "v" (e.g. "v3.19.1" -> "3.19.1").
  if (version.charCodeAt(0) === 0x76 /* "v" */) {
    version = version.slice(1);
  }

  // The first character must be alphanumeric, which rejects "", "v", ".", ".."
  // and any other value that could escape or alias a directory as a path segment.
  const first = version.charCodeAt(0);
  const startsAlphanumeric =
    (first >= 0x30 && first <= 0x39) || // 0-9
    (first >= 0x41 && first <= 0x5a) || // A-Z
    (first >= 0x61 && first <= 0x7a); // a-z

  return startsAlphanumeric ? version : null;
}

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
      // The response body is untrusted input: only use it when it is a valid tag.
      const version = typeof data.tag_name === "string" ? sanitizeLuaLSVersion(data.tag_name) : null;
      if (version) {
        return version;
      }
    }
  } catch {
    // Network error or rate limit fallback
  }
  return FALLBACK_LUALS_VERSION;
}

/**
 * Resolves a version string ("latest" -> actual tag).
 *
 * @throws when an explicitly requested version is not a valid tag.
 */
export async function resolveLuaLSVersion(version?: string): Promise<string> {
  if (!version || version === "latest") {
    return await resolveLatestLuaLSVersion();
  }
  const sanitized = sanitizeLuaLSVersion(version);
  if (!sanitized) {
    throw new Error(
      `Invalid LuaLS version: "${version}". Expected a release tag such as "3.19.1", or "latest".`
    );
  }
  return sanitized;
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
  return path.join(systemPaths.cache, "luals", version);
}

export interface DownloadOptions {
  quiet?: boolean;
}

/**
 * Verifies that a LuaLS binary exists, has non-trivial size, and is executable.
 */
export function isBinaryValid(binaryPath: string): boolean {
  if (!fs.existsSync(binaryPath)) {
    return false;
  }
  try {
    const stats = fs.statSync(binaryPath);
    if (!stats.isFile() || stats.size < 100_000) {
      return false;
    }
    const output = execFileSync(binaryPath, ["--version"], {
      timeout: 5000,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return /^\d+\.\d+\.\d+/.test(output.trim());
  } catch {
    return false;
  }
}

export async function downloadAndExtractLuaLS(
  version: string = DEFAULT_LUALS_VERSION,
  targetDir?: string,
  options?: DownloadOptions
): Promise<string> {
  const resolvedVersion = await resolveLuaLSVersion(version);
  const info = getPlatformInfo(resolvedVersion);
  const destDir = targetDir || getCacheDir(resolvedVersion);
  const binaryPath = path.join(destDir, info.binaryRelativePath);
  const completeMarker = path.join(destDir, ".complete");

  if (fs.existsSync(destDir)) {
    if (fs.existsSync(binaryPath) && isBinaryValid(binaryPath)) {
      if (!fs.existsSync(completeMarker)) {
        try {
          fs.writeFileSync(completeMarker, resolvedVersion, "utf-8");
        } catch {
          // Ignore marker write error
        }
      }
      return binaryPath;
    }
    // destDir exists but is invalid/corrupted: clean it up before downloading
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }

  const parentDir = path.dirname(destDir);
  fs.mkdirSync(parentDir, { recursive: true });

  const tempDir = path.join(
    parentDir,
    `.${path.basename(destDir)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(tempDir, { recursive: true });

  const url = `https://github.com/LuaLS/lua-language-server/releases/download/${resolvedVersion}/${info.assetName}`;
  const archivePath = path.join(tempDir, info.assetName);

  if (!options?.quiet) {
    console.log(`[luals] Downloading LuaLS ${resolvedVersion} from ${url}...`);
  }

  let response: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok && res.body) {
        response = res;
        break;
      }
      await res.body?.cancel();
      lastErr = new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  if (!response || !response.body) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
    throw lastErr || new Error(`Failed to download ${url}`);
  }

  try {
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(archivePath, Buffer.from(arrayBuffer));

    if (!options?.quiet) {
      console.log(`[luals] Extracting to ${destDir}...`);
    }

    try {
      // Both Windows 10+ and UNIX systems have tar built in
      await execFileAsync("tar", ["-xf", archivePath, "-C", tempDir]);
    } catch (tarErr) {
      // Fallback for PowerShell Expand-Archive on Windows if tar fails
      if (process.platform === "win32" && info.assetName.endsWith(".zip")) {
        await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${escapePowerShellSingleQuote(archivePath)}' -DestinationPath '${escapePowerShellSingleQuote(tempDir)}' -Force`,
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

    const tempBinaryPath = path.join(tempDir, info.binaryRelativePath);

    // Make executable on unix
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(tempBinaryPath, 0o755);
      } catch {
        // Ignore chmod error
      }
    }

    // Verify file exists and has non-trivial size before promotion
    if (!fs.existsSync(tempBinaryPath) || fs.statSync(tempBinaryPath).size < 100_000) {
      throw new Error(`Failed to extract valid LuaLS binary to expected path: ${tempBinaryPath}`);
    }

    // Write .complete marker in tempDir before promotion
    fs.writeFileSync(path.join(tempDir, ".complete"), resolvedVersion, "utf-8");

    // Atomic promotion with retry and race resolution
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tempDir, destDir);
        break;
      } catch (renameErr) {
        if (fs.existsSync(binaryPath) && isBinaryValid(binaryPath)) {
          // A concurrent worker already promoted destDir successfully
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup error
          }
          if (!options?.quiet) {
            console.log(`[luals] Ready: ${binaryPath}`);
          }
          return binaryPath;
        }
        if (attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        } else {
          throw renameErr;
        }
      }
    }

    if (!isBinaryValid(binaryPath)) {
      throw new Error(`Extracted LuaLS binary at ${binaryPath} is invalid or non-functional.`);
    }

    if (!options?.quiet) {
      console.log(`[luals] Ready: ${binaryPath}`);
    }
    return binaryPath;
  } finally {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
  }
}

export interface ResolveLuaLSOptions {
  quiet?: boolean;
}

export async function resolveLuaLSBinary(
  version: string = DEFAULT_LUALS_VERSION,
  options?: ResolveLuaLSOptions
): Promise<string> {
  // 1. Explicit env var
  if (process.env.LUALS_BIN && fs.existsSync(process.env.LUALS_BIN)) {
    return process.env.LUALS_BIN;
  }

  const resolvedVersion = await resolveLuaLSVersion(version);
  const info = getPlatformInfo(resolvedVersion);

  // 2. Bundled with package (release distribution)
  const bundledPath = path.join(getPackageRoot(), info.binaryRelativePath);
  if (fs.existsSync(bundledPath) && isBinaryValid(bundledPath)) {
    return bundledPath;
  }

  // 3. User cache
  const cachedDir = getCacheDir(resolvedVersion);
  const cachedPath = path.join(cachedDir, info.binaryRelativePath);
  const completeMarker = path.join(cachedDir, ".complete");

  if (fs.existsSync(cachedPath)) {
    if (isBinaryValid(cachedPath)) {
      if (!fs.existsSync(completeMarker)) {
        try {
          fs.writeFileSync(completeMarker, resolvedVersion, "utf-8");
        } catch {
          // Ignore marker write error
        }
      }
      return cachedPath;
    }
    // Cached binary is corrupted/incomplete - clean up and re-download
    if (!options?.quiet) {
      console.warn(`[luals] Cached LuaLS binary at ${cachedPath} is corrupted or incomplete. Repairing...`);
    }
    try {
      fs.rmSync(cachedDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }

  // 4. In PATH
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(cmd, ["lua-language-server"]);
    const found = stdout.trim().split(/\r?\n/)[0];
    if (found && fs.existsSync(found) && isBinaryValid(found)) {
      return found;
    }
  } catch {
    // Not in PATH
  }

  // 5. Download and cache
  return await downloadAndExtractLuaLS(resolvedVersion, undefined, options);
}

export async function runLuaLSCheck(
  targetPath: string,
  configPath: string,
  options: CheckOptions
): Promise<CheckResult> {
  const absoluteTarget = path.resolve(targetPath);
  if (!fs.existsSync(absoluteTarget)) {
    throw new Error(`Target path does not exist: ${targetPath}`);
  }

  const binary =
    options.lualsBin ||
    (await resolveLuaLSBinary(options.lualsVersion, { quiet: options.quiet }));

  let checkDir = absoluteTarget;
  let targetFileOnly: string | null = null;

  if (fs.statSync(absoluteTarget).isFile()) {
    checkDir = path.dirname(absoluteTarget);
    targetFileOnly = absoluteTarget;
  }

  const tempOutputDir = systemPaths.temp;
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

  let execError: unknown = null;
  try {
    await execFileAsync(binary, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (err) {
    execError = err;
    // Process may exit with non-zero when diagnostics are found
  }

  let diagnostics: DiagnosticReport = {};
  let parseSucceeded = false;
  if (fs.existsSync(checkOutPath)) {
    try {
      const content = fs.readFileSync(checkOutPath, "utf-8");
      diagnostics = JSON.parse(content) as DiagnosticReport;
      parseSucceeded = true;
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

  if (!parseSucceeded) {
    const cacheHint = `(Cache location: ${getCacheDir()})`;
    if (execError) {
      throw new Error(
        `LuaLS check failed to execute or produce diagnostic output: ${execError instanceof Error ? execError.message : String(execError)}. ${cacheHint}`
      );
    }
    throw new Error(
      `LuaLS check failed to produce diagnostic output at: ${checkOutPath}. ${cacheHint}`
    );
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
  let totalErrors = 0;
  let totalWarnings = 0;
  let problemFiles = 0;

  for (const [_, diags] of Object.entries(diagnostics)) {
    if (diags.length > 0) {
      problemFiles += 1;
      totalProblems += diags.length;
      for (const d of diags) {
        if (d.severity === 1) {
          totalErrors += 1;
        } else if (d.severity === 2) {
          totalWarnings += 1;
        }
      }
    }
  }

  const passed = totalProblems === 0;
  const filesChecked = countCheckedFiles(targetPath, configPath);
  const totalFiles = passed ? filesChecked : problemFiles;

  return {
    passed,
    totalProblems,
    totalErrors,
    totalWarnings,
    totalFiles,
    totalFilesChecked: filesChecked,
    diagnostics,
  };
}

/**
 * Counts candidate Lua files within targetPath, taking ignoreDir and files.exclude into account.
 */
export function countCheckedFiles(targetPath: string, configPath?: string): number {
  const absPath = path.resolve(targetPath);
  if (!fs.existsSync(absPath)) {
    return 0;
  }

  if (fs.statSync(absPath).isFile()) {
    return absPath.toLowerCase().endsWith(".lua") ? 1 : 0;
  }

  let ignoreDirs: string[] = [".git", ".vscode", ".nanos-lint", "node_modules"];
  let excludePatterns: string[] = [];

  if (configPath && fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as LuaRCConfig;
      if (cfg.workspace?.ignoreDir) {
        ignoreDirs = cfg.workspace.ignoreDir;
      }
      if (cfg.files?.exclude) {
        excludePatterns = cfg.files.exclude;
      }
    } catch {
      // Ignore config parse error
    }
  }

  const normIgnoreDirs = new Set(ignoreDirs.map((d) => d.replace(/\\/g, "/").toLowerCase()));

  function isExcluded(relPath: string): boolean {
    const norm = relPath.replace(/\\/g, "/");
    const baseName = path.posix.basename(norm);

    for (const pat of excludePatterns) {
      const normPat = pat.replace(/\\/g, "/");
      if (norm === normPat || baseName === normPat) return true;
      if (normPat.endsWith("/**")) {
        const dir = normPat.slice(0, -3);
        if (norm === dir || norm.startsWith(`${dir}/`)) return true;
      }
      if (norm.startsWith(`${normPat}/`)) return true;

      if (normPat.includes("*") || normPat.includes("?")) {
        // If pattern has no slash, it matches basename anywhere
        if (!normPat.includes("/")) {
          const baseRegexStr =
            "^" +
            normPat
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".") +
            "$";
          try {
            if (new RegExp(baseRegexStr, "i").test(baseName)) return true;
          } catch {
            // Ignore
          }
        }

        // Convert glob with ** and * to regex matching full relPath
        let regexStr = normPat;
        const hasLeadingDoubleStar = regexStr.startsWith("**/");
        if (hasLeadingDoubleStar) {
          regexStr = regexStr.slice(3);
        }
        const hasTrailingDoubleStar = regexStr.endsWith("/**");
        if (hasTrailingDoubleStar) {
          regexStr = regexStr.slice(0, -3);
        }

        let escaped = regexStr
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\/\*\*\//g, "/(?:.*/)?")
          .replace(/\*\*/g, ".*")
          .replace(/(?<!\.)\*/g, "[^/]*")
          .replace(/\?/g, "[^/]");

        if (hasLeadingDoubleStar) {
          escaped = `(?:^|.*/)${escaped}`;
        }
        if (hasTrailingDoubleStar) {
          escaped = `${escaped}(?:/.*)?`;
        }

        try {
          if (new RegExp(`^${escaped}$`, "i").test(norm)) return true;
        } catch {
          // Ignore regex syntax error
        }
      }
    }
    return false;
  }

  let count = 0;

  function walk(currentDir: string, relDir: string = "") {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const relPath = relDir ? `${relDir}/${name}` : name;
      const fullPath = path.join(currentDir, name);

      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (() => {
            try {
              return fs.statSync(fullPath).isDirectory();
            } catch {
              return false;
            }
          })());

      if (isDirectory) {
        const lowerName = name.toLowerCase();
        if (normIgnoreDirs.has(lowerName) || normIgnoreDirs.has(relPath.toLowerCase())) {
          continue;
        }
        if (isExcluded(relPath) || isExcluded(`${relPath}/**`)) {
          continue;
        }
        walk(fullPath, relPath);
      } else if (entry.isFile() && name.toLowerCase().endsWith(".lua")) {
        if (!isExcluded(relPath)) {
          count++;
        }
      }
    }
  }

  walk(absPath);
  return count;
}

