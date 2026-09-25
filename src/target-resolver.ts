import fs from "node:fs";
import path from "node:path";
import { fileUriToPath } from "./types.js";
import type { DiagnosticReport } from "./types.js";
import { LuaLSError, ConfigError } from "./errors.js";

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

  const splitPaths = resolved.map((p) => path.resolve(p).split(path.sep));
  const minLen = Math.min(...splitPaths.map((p) => p.length));
  let commonLen = 0;

  const first = splitPaths[0];
  if (!first) {
    return path.resolve(".");
  }

  const isWin = process.platform === "win32";
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
  const normRel = isWin
    ? relativePath.replace(/\\/g, "/").toLowerCase()
    : relativePath.replace(/\\/g, "/");

  for (const rawTarget of targetPaths) {
    let relTarget: string;
    if (path.isAbsolute(rawTarget)) {
      relTarget = path.relative(root, rawTarget).replace(/\\/g, "/");
    } else {
      const fromCwd = path.resolve(rawTarget);
      const relFromCwd = path.relative(root, fromCwd).replace(/\\/g, "/");
      if (!relFromCwd.startsWith("../") && relFromCwd !== "..") {
        relTarget = relFromCwd;
      } else {
        relTarget = rawTarget.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
      }
    }

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
  for (const [uri, diags] of Object.entries(report)) {
    const filePath = fileUriToPath(uri);
    const relative = path.relative(root, path.resolve(filePath)).replace(/\\/g, "/");
    if (matchesTargetPaths(relative, root, targetPaths)) {
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

  for (const targetPath of paths) {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new LuaLSError(
        `Target path does not exist: ${targetPath}`,
        "ERR_TARGET_NOT_FOUND",
        "Verify that the target path exists and is accessible.",
      );
    }
  }

  const first = paths[0];
  if (paths.length === 1 && first) {
    return { rootPath: first, targetPaths: paths };
  }

  const rootPath = findCommonAncestorDirectory(paths);
  return { rootPath, targetPaths: paths };
}
