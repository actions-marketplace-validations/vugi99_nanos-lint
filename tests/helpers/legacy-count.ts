import fs from "node:fs";
import path from "node:path";
import type { LuaRCConfig } from "../../src/types.js";

/**
 * Frozen copy of the `countCheckedFiles()` implementation shipped before #27
 * (hand-rolled recursive walk plus glob-to-regex translation).
 *
 * It exists only as a differential reference for
 * `tests/unit/glob-parity.test.ts`: every future change to the bundled-glob
 * implementation can be re-checked against the behaviour users had before, so
 * the intended differences (documented in that test) stay the *only* ones.
 * It is never imported by `src/`.
 */
const LEGACY_DEFAULT_IGNORE_DIRS = [".git", ".vscode", ".nanos-lint", "node_modules"];

export function legacyCountCheckedFiles(targetPath: string, configPath?: string): number {
  const absPath = path.resolve(targetPath);
  if (!fs.existsSync(absPath)) {
    return 0;
  }

  if (fs.statSync(absPath).isFile()) {
    return absPath.toLowerCase().endsWith(".lua") ? 1 : 0;
  }

  let ignoreDirs: string[] = LEGACY_DEFAULT_IGNORE_DIRS;
  let excludePatterns: string[] = [];

  if (configPath && fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as LuaRCConfig;
    if (cfg.workspace?.ignoreDir) {
      ignoreDirs = cfg.workspace.ignoreDir;
    }
    if (cfg.files?.exclude) {
      excludePatterns = cfg.files.exclude;
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
          if (new RegExp(baseRegexStr, "i").test(baseName)) return true;
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

        if (new RegExp(`^${escaped}$`, "i").test(norm)) return true;
      }
    }
    return false;
  }

  let count = 0;

  function walk(currentDir: string, relDir = "") {
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
