import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { loadUserConfig, resolveRealmMappings } from "./config.js";
import type { LuaRCConfig } from "./types.js";

/** Accumulates repeatable --dep arguments. */
export function collectDeps(val: string, prev?: string[]): string[] {
  const trimmed = val.trim();
  if (!trimmed) {
    return prev ?? [];
  }
  return (prev ?? []).concat(trimmed);
}

export interface ResolvedDependencyRealms {
  /** Libraries to include in server realm passes (Server + Shared folders, or shared files). */
  server: string[];
  /** Libraries to include in client realm passes (Client + Shared folders, or shared files). */
  client: string[];
  /** Libraries to include in shared realm passes (Shared folders, or shared files). */
  shared: string[];
  /** All libraries for a single standard pass (realms disabled). */
  all: string[];
}

interface DepQueueItem {
  rawPath: string;
  fromDir: string;
}

/** Normalizes a filesystem path to forward slashes for LuaLS compatibility. */
function normalizeSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolves package dependencies declared in .luarc.json (nanos.deps) or via CLI (--dep),
 * resolving transitive dependencies with cycle detection and partitioning them by realm.
 */
export function resolvePackageDependencies(
  root: string,
  userConfig: LuaRCConfig,
  cliDeps?: string[],
): ResolvedDependencyRealms {
  const visited = new Set<string>();
  const queue: DepQueueItem[] = [];

  if (cliDeps && cliDeps.length > 0) {
    for (const dep of cliDeps) {
      if (typeof dep === "string" && dep.trim()) {
        queue.push({ rawPath: dep.trim(), fromDir: process.cwd() });
      }
    }
  }

  const rawConfigDeps = userConfig.nanos?.deps;
  if (rawConfigDeps !== undefined) {
    if (Array.isArray(rawConfigDeps)) {
      for (const dep of rawConfigDeps) {
        if (typeof dep === "string" && dep.trim()) {
          queue.push({ rawPath: dep.trim(), fromDir: root });
        } else {
          logger.warn(`[deps] Skipping invalid nanos.deps entry: expected a string path.`);
        }
      }
    } else {
      logger.warn(`[deps] Ignoring nanos.deps: expected an array of path strings.`);
    }
  }

  const resolvedFiles: string[] = [];
  const resolvedDirs: string[] = [];

  const isWin = process.platform === "win32";

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      continue;
    }

    const { rawPath, fromDir } = item;
    const absPath = path.resolve(fromDir, rawPath);

    if (!fs.existsSync(absPath)) {
      logger.warn(`[deps] Dependency path not found: "${rawPath}" (skipping).`);
      continue;
    }

    let canonical: string;
    try {
      canonical = fs.realpathSync.native(absPath);
    } catch (err) {
      void err;
      try {
        canonical = fs.realpathSync(absPath);
      } catch (innerErr) {
        void innerErr;
        canonical = absPath;
      }
    }

    const cycleKey = isWin ? canonical.toLowerCase() : canonical;
    if (visited.has(cycleKey)) {
      continue;
    }
    visited.add(cycleKey);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(canonical);
    } catch (err) {
      void err;
      continue;
    }

    if (stat.isFile()) {
      if (canonical.toLowerCase().endsWith(".lua")) {
        resolvedFiles.push(normalizeSlash(canonical));
      } else {
        logger.warn(`[deps] Skipping non-Lua dependency file: "${rawPath}".`);
      }
      continue;
    }

    if (stat.isDirectory()) {
      resolvedDirs.push(canonical);

      const candidateLuarc = path.join(canonical, ".luarc.json");
      if (fs.existsSync(candidateLuarc)) {
        try {
          const depConfig = loadUserConfig(canonical);
          const transDeps = depConfig.nanos?.deps;
          if (transDeps !== undefined) {
            if (Array.isArray(transDeps)) {
              for (const trans of transDeps) {
                if (typeof trans === "string" && trans.trim()) {
                  queue.push({ rawPath: trans.trim(), fromDir: canonical });
                } else {
                  logger.warn(
                    `[deps] Skipping invalid nanos.deps entry in "${canonical}": expected a string path.`,
                  );
                }
              }
            } else {
              logger.warn(
                `[deps] Ignoring nanos.deps in "${canonical}": expected an array of path strings.`,
              );
            }
          }
        } catch (err) {
          logger.warn(
            `[deps] Failed to parse transitive dependency configuration at "${candidateLuarc}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  const serverSet = new Set<string>();
  const clientSet = new Set<string>();
  const sharedSet = new Set<string>();
  const allSet = new Set<string>();

  for (const file of resolvedFiles) {
    serverSet.add(file);
    clientSet.add(file);
    sharedSet.add(file);
    allSet.add(file);
  }

  for (const depDir of resolvedDirs) {
    const normDepDir = normalizeSlash(depDir);
    allSet.add(normDepDir);

    let depConfig: LuaRCConfig = {};
    try {
      depConfig = loadUserConfig(depDir);
    } catch (err) {
      void err;
    }

    const { enabled, mappings } = resolveRealmMappings(depConfig);

    if (!enabled) {
      serverSet.add(normDepDir);
      clientSet.add(normDepDir);
      sharedSet.add(normDepDir);
      continue;
    }

    const serverFolder = path.join(depDir, "Server");
    const clientFolder = path.join(depDir, "Client");
    const sharedFolder = path.join(depDir, "Shared");

    const hasServer = fs.existsSync(serverFolder);
    const hasClient = fs.existsSync(clientFolder);
    const hasShared = fs.existsSync(sharedFolder);

    if (hasServer || hasClient || hasShared) {
      if (hasServer) {
        serverSet.add(normalizeSlash(serverFolder));
      }
      if (hasClient) {
        clientSet.add(normalizeSlash(clientFolder));
      }
      if (hasShared) {
        const normShared = normalizeSlash(sharedFolder);
        serverSet.add(normShared);
        clientSet.add(normShared);
        sharedSet.add(normShared);
      }

      try {
        const entries = fs.readdirSync(depDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.toLowerCase().endsWith(".lua")) {
            const rootFile = normalizeSlash(path.join(depDir, entry.name));
            serverSet.add(rootFile);
            clientSet.add(rootFile);
            sharedSet.add(rootFile);
          }
        }
      } catch (err) {
        void err;
      }
      continue;
    }

    if (depConfig.nanos?.realms) {
      let matchedAnyCustom = false;
      for (const { pattern, realm } of mappings) {
        const baseFolder = pattern.replace(/\/\*\*.*$/, "").replace(/\/\*.*$/, "");
        const targetPath = path.join(depDir, baseFolder);
        if (fs.existsSync(targetPath)) {
          matchedAnyCustom = true;
          const norm = normalizeSlash(targetPath);
          if (realm === "server") {
            serverSet.add(norm);
          } else if (realm === "client") {
            clientSet.add(norm);
          } else {
            serverSet.add(norm);
            clientSet.add(norm);
            sharedSet.add(norm);
          }
        }
      }
      if (matchedAnyCustom) {
        continue;
      }
    }

    serverSet.add(normDepDir);
    clientSet.add(normDepDir);
    sharedSet.add(normDepDir);
  }

  return {
    server: Array.from(serverSet),
    client: Array.from(clientSet),
    shared: Array.from(sharedSet),
    all: Array.from(allSet),
  };
}
