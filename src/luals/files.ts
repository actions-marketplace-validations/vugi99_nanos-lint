import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type { LuaRCConfig } from "../types.js";

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
    } catch (err) {
      logger.warn(
        `[luals] Failed to parse config file for file counting at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
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
          } catch (err) {
            logger.debug(
              `[luals] Invalid regex for pattern "${normPat}": ${err instanceof Error ? err.message : String(err)}`
            );
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
        } catch (err) {
          logger.debug(
            `[luals] Invalid glob regex for pattern "${normPat}": ${err instanceof Error ? err.message : String(err)}`
          );
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
    } catch (err) {
      logger.debug(
        `[luals] Failed to read directory ${currentDir}: ${err instanceof Error ? err.message : String(err)}`
      );
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
            } catch (err) {
              logger.debug(
                `[luals] Failed to stat symlink target ${fullPath}: ${err instanceof Error ? err.message : String(err)}`
              );
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

