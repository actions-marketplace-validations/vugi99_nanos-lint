import fs from "node:fs";
import path from "node:path";
import { stripTrailingSlashes } from "./config.js";
import { logger } from "./logger.js";
import { fileUriToPath } from "./types.js";
import type { DiagnosticReport } from "./types.js";
import { LuaLSError, ConfigError } from "./errors.js";

/** Resolves the canonical filesystem path, falling back to original path on failure. */
export function getCanonicalPath(p: string): string {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Determines whether a path points to the root of a filesystem volume. */
export function isFilesystemRoot(dir: string): boolean {
  const stripped = dir.trim();
  if (stripped === "/" || stripped === "\\" || stripped === "") {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]?$/.test(stripped)) {
    return true;
  }
  const norm = path.resolve(stripped);
  if (norm === "/" || norm === "\\") {
    return true;
  }
  return /^[a-zA-Z]:[\\/]?$/.test(norm);
}

/**
 * Computes the lowest common ancestor directory for a set of paths.
 * All paths must reside on the same filesystem root or volume.
 */
export function findCommonAncestorDirectory(paths: string[]): string {
  if (paths.length === 0) {
    return path.resolve(".");
  }

  const resolved = paths.map((p) => {
    const abs = path.resolve(p);
    try {
      if (fs.existsSync(abs)) {
        return fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      }
    } catch (err) {
      void err;
    }
    return path.dirname(abs);
  });

  if (resolved.length === 1 && resolved[0]) {
    return resolved[0];
  }

  const isWin = process.platform === "win32";
  const splitPaths = resolved.map((p) => path.resolve(p).split(path.sep));

  const first = splitPaths[0];
  if (!first || first.length === 0) {
    return path.resolve(".");
  }

  const firstRoot = first[0];
  const sameDrive = splitPaths.every((p) => {
    const rootSeg = p[0];
    if (rootSeg === undefined) return false;
    return isWin ? rootSeg.toLowerCase() === firstRoot?.toLowerCase() : rootSeg === firstRoot;
  });

  if (!sameDrive || firstRoot === undefined) {
    throw new ConfigError(
      `Cannot check paths across different root drives or volumes: ${paths.join(", ")}`,
      "ERR_MULTIPLE_ROOTS",
      "Ensure all checked paths are within the same workspace or project root.",
    );
  }

  const minLen = Math.min(...splitPaths.map((p) => p.length));
  let commonLen = 0;

  for (let i = 0; i < minLen; i++) {
    const segment = first[i];
    if (segment === undefined) {
      break;
    }
    const allMatch = splitPaths.every((p) => {
      const seg = p[i];
      if (seg === undefined) {
        return false;
      }
      return isWin ? seg.toLowerCase() === segment.toLowerCase() : seg === segment;
    });
    if (!allMatch) {
      break;
    }
    commonLen++;
  }

  if (commonLen === 0) {
    throw new ConfigError(
      `Cannot check paths across different root drives or volumes: ${paths.join(", ")}`,
      "ERR_MULTIPLE_ROOTS",
      "Ensure all checked paths are within the same workspace or project root.",
    );
  }

  let commonPath = first.slice(0, commonLen).join(path.sep);
  if (!commonPath) {
    commonPath = path.sep;
  }
  if (isWin && /^[a-zA-Z]:$/.test(commonPath)) {
    commonPath = `${commonPath}\\`;
  }
  return path.resolve(commonPath);
}

/**
 * Searches upward from a starting directory to locate an enclosing project root
 * containing `.luarc.json`. Returns the start directory if not found.
 */
export function findProjectRoot(startDir: string): string {
  let curr = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(curr, ".luarc.json"))) {
      return curr;
    }
    if (fs.existsSync(path.join(curr, ".git"))) {
      break;
    }
    const parent = path.dirname(curr);
    if (parent === curr) {
      break;
    }
    curr = parent;
  }
  return startDir;
}

/**
 * Characters the LuaLS glob matcher treats as syntax.
 *
 * LuaLS compiles `files.exclude` with `glob.gitignore` (see its
 * `script/glob/glob.lua`), whose grammar only understands backslash escapes:
 * bracket expressions such as `[[]` are parsed as character ranges and match
 * nothing useful. Escaping is therefore done with `\`.
 */
const GLOB_METACHARACTERS: ReadonlySet<string> = new Set(["*", "?", "[", "]", "{", "}", ",", "\\"]);

/**
 * Escapes the glob metacharacters of a single path segment so it matches literally.
 *
 * Note: `normalizePattern()` in `src/luals/files.ts` rewrites backslashes to path
 * separators when counting checked files, so these escapes only reach LuaLS. That is
 * harmless: the counted file set is filtered by the requested target paths anyway.
 */
function escapeGlobSegment(segment: string): string {
  let escaped = "";
  for (const char of segment) {
    escaped += GLOB_METACHARACTERS.has(char) ? `\\${char}` : char;
  }
  return escaped;
}

/** Escapes glob metacharacters in every segment of a slash-separated relative path. */
function escapeGlobPath(relativePath: string): string {
  return relativePath.split("/").map(escapeGlobSegment).join("/");
}

/**
 * Computes glob exclusion patterns for directories and files under workspace root
 * that are completely outside the requested target paths.
 */
export function computeUnrequestedExclusions(root: string, targetPaths: string[]): string[] {
  const resolvedRoot = path.resolve(root);

  if (
    targetPaths.length === 0 ||
    targetPaths.some((t) => t === "." || t === "" || path.resolve(resolvedRoot, t) === resolvedRoot)
  ) {
    return [];
  }

  const isWin = process.platform === "win32";
  const canonicalRoot = getCanonicalPath(resolvedRoot);

  const relTargets = targetPaths
    .map((t) => {
      const resolved = path.isAbsolute(t) ? t : path.resolve(canonicalRoot, t);
      const canonical = getCanonicalPath(resolved);
      const rel = path.relative(canonicalRoot, canonical).replace(/\\/g, "/");
      return isWin ? rel.toLowerCase() : rel;
    })
    .filter((rel) => !rel.startsWith("../") && rel !== "..");

  if (relTargets.length === 0 || relTargets.includes("") || relTargets.includes(".")) {
    return [];
  }

  const exclusions: string[] = [];

  /** Recursively scans directory entries to identify unrequested paths. */
  function scanDir(dir: string, relPrefix: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const normEntry = isWin ? entryRel.toLowerCase() : entryRel;

      let isExactTarget = false;
      let isAncestorOfTarget = false;
      let isDescendantOfTarget = false;

      for (const target of relTargets) {
        if (normEntry === target) {
          isExactTarget = true;
          break;
        }
        if (target.startsWith(`${normEntry}/`)) {
          isAncestorOfTarget = true;
          break;
        }
        if (normEntry.startsWith(`${target}/`)) {
          isDescendantOfTarget = true;
          break;
        }
      }

      if (isExactTarget || isDescendantOfTarget) {
        continue;
      }

      if (isAncestorOfTarget) {
        if (entry.isDirectory()) {
          scanDir(path.join(dir, entry.name), entryRel);
        }
        continue;
      }

      // Dot-directories are excluded like any other unrequested sibling: skipping
      // them would leave their `.lua` files visible to LuaLS, where they could still
      // define globals for the requested targets.
      if (entry.isDirectory()) {
        exclusions.push(`${escapeGlobPath(entryRel)}/**`);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lua")) {
        exclusions.push(escapeGlobPath(entryRel));
      }
    }
  }

  scanDir(canonicalRoot, "");
  return exclusions;
}

/** Determines whether a workspace-relative file path matches any of the target paths. */
export function matchesTargetPaths(
  relativePath: string,
  root: string,
  targetPaths: string[],
): boolean {
  if (
    targetPaths.length === 0 ||
    (targetPaths.length === 1 && (targetPaths[0] === "." || targetPaths[0] === ""))
  ) {
    return true;
  }

  const isWin = process.platform === "win32";
  const canonicalRoot = getCanonicalPath(root);
  const normRel = isWin
    ? relativePath.replace(/\\/g, "/").toLowerCase()
    : relativePath.replace(/\\/g, "/");

  for (const rawTarget of targetPaths) {
    const fromCwd = path.resolve(rawTarget);
    const resolvedTarget = fs.existsSync(fromCwd)
      ? fromCwd
      : path.isAbsolute(rawTarget)
        ? rawTarget
        : path.resolve(canonicalRoot, rawTarget);
    const canonicalTarget = getCanonicalPath(resolvedTarget);

    let relTarget = path.relative(canonicalRoot, canonicalTarget).replace(/\\/g, "/");
    relTarget = stripTrailingSlashes(relTarget).replace(/^\.\//, "");

    const normTarget = isWin ? relTarget.toLowerCase() : relTarget;

    if (normTarget === "" || normTarget === ".") {
      return true;
    }
    if (normRel === normTarget || normRel.startsWith(`${normTarget}/`)) {
      return true;
    }
  }

  return false;
}

/** Keeps only diagnostics for files that match the requested target paths. */
export function filterReportByTargetPaths(
  report: DiagnosticReport,
  root: string,
  targetPaths: string[],
): DiagnosticReport {
  if (
    targetPaths.length === 0 ||
    (targetPaths.length === 1 && (targetPaths[0] === "." || targetPaths[0] === ""))
  ) {
    return report;
  }

  const filtered: DiagnosticReport = {};
  const canonicalRoot = getCanonicalPath(root);

  for (const [uri, diags] of Object.entries(report)) {
    const filePath = fileUriToPath(uri);
    const canonicalFile = getCanonicalPath(path.resolve(filePath));
    const relative = path.relative(canonicalRoot, canonicalFile).replace(/\\/g, "/");
    if (matchesTargetPaths(relative, canonicalRoot, targetPaths)) {
      filtered[uri] = diags;
    }
  }
  return filtered;
}

export interface ResolvedCheckTargets {
  rootPath: string;
  targetPaths: string[];
}

/** Validates and resolves CLI target paths into a common root directory and target list. */
export function resolveCheckTargets(rawPaths?: string[]): ResolvedCheckTargets {
  const paths = rawPaths && rawPaths.length > 0 ? rawPaths : ["."];

  const canonicalTargets = paths.map((targetPath) => {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new LuaLSError(
        `Target path does not exist: ${targetPath}`,
        "ERR_TARGET_NOT_FOUND",
        "Verify that the target path exists and is accessible.",
      );
    }
    return getCanonicalPath(resolved);
  });

  const first = paths[0];
  if (paths.length === 1 && first) {
    const canonicalFirst = canonicalTargets[0]!;
    const isFile = fs.statSync(canonicalFirst).isFile();
    const startDir = isFile ? path.dirname(canonicalFirst) : canonicalFirst;
    const projRoot = findProjectRoot(startDir);
    if (projRoot !== startDir) {
      // Only reachable when `findProjectRoot` walked up to an ancestor holding a
      // `.luarc.json`; a filesystem root never contains one in practice, so this
      // guard is defensive. The target being the filesystem root itself is left
      // alone on purpose: the user asked for that directory explicitly.
      if (isFilesystemRoot(projRoot)) {
        throw new ConfigError(
          `Cannot check targets across the root filesystem (${projRoot}): checked paths must share a common project directory.`,
          "ERR_ROOT_ANCESTOR",
          "Ensure all checked paths reside within a common project directory.",
        );
      }
      logger.debug(`[targets] Using discovered project root "${projRoot}" for "${first}".`);
      return { rootPath: projRoot, targetPaths: canonicalTargets };
    }
    return { rootPath: first, targetPaths: canonicalTargets };
  }

  const ancestor = findCommonAncestorDirectory(canonicalTargets);
  if (isFilesystemRoot(ancestor)) {
    throw new ConfigError(
      `Cannot check targets across the root filesystem (${ancestor}): checked paths must share a common project directory.`,
      "ERR_ROOT_ANCESTOR",
      "Ensure all checked paths reside within a common project directory.",
    );
  }

  const rootPath = findProjectRoot(ancestor);
  if (rootPath !== ancestor) {
    logger.debug(`[targets] Using discovered project root "${rootPath}" for "${ancestor}".`);
  }
  return { rootPath, targetPaths: canonicalTargets };
}
