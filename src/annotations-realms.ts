import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { writeAtomicFileSync } from "./lock.js";
import { systemPaths } from "./paths.js";

/** Realm name used by a pass; `global` is normalized to `shared` before this point. */
export type RealmPassName = "client" | "server" | "shared";

/** Side markers emitted by the upstream docgen, mapped to the realm that owns them. */
const SIDE_MARKERS: ReadonlyArray<readonly [image: string, realm: RealmPassName]> = [
  ["both", "shared"],
  ["client-only", "client"],
  ["server-only", "server"],
  ["authority-only", "shared"],
  ["network-authority", "shared"],
];

/** Declaration forms recognized while segmenting `annotations.lua`. */
type AnnotationUnitKind = "comment" | "class" | "static" | "instance" | "other";

interface AnnotationUnit {
  doc: string[];
  decl: string[] | null;
  key: string | null;
  receiver: string | null;
  owner: RealmPassName | null;
  realm: RealmPassName;
  kind: AnnotationUnitKind;
}

/** Finds the realm declared by the side marker of a documentation block. */
function realmOfDocBlock(doc: string[]): RealmPassName | null {
  for (const line of doc) {
    for (const [image, realm] of SIDE_MARKERS) {
      if (line.includes(`assets/${image}.png`)) {
        return realm;
      }
    }
  }
  return null;
}

/** Extracts `Receiver.member` for both `function X:y()` and `function X.y()` forms. */
function memberKeyOf(declaration: string | null): string | null {
  if (!declaration) {
    return null;
  }
  const member = /^(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)[.:]([A-Za-z_][A-Za-z0-9_]*)/.exec(
    declaration,
  );
  if (member) {
    return `${member[1]}.${member[2]}`;
  }
  const global = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(declaration);
  return global ? global[1]! : null;
}

/** Extracts the class/table a declaration belongs to. */
function receiverOf(declaration: string | null): string | null {
  if (!declaration) {
    return null;
  }
  const member = /^(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)[.:]/.exec(declaration);
  if (member) {
    return member[1]!;
  }
  const global = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(declaration);
  return global ? global[1]! : null;
}

/** Classifies a declaration so static members can inherit their class realm. */
function kindOf(declaration: string | null): AnnotationUnitKind {
  if (!declaration) {
    return "comment";
  }
  if (/^function\s+[A-Za-z_][A-Za-z0-9_]*\./.test(declaration)) {
    return "static";
  }
  if (/^function\s+[A-Za-z_][A-Za-z0-9_]*:/.test(declaration)) {
    return "instance";
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\{/.test(declaration)) {
    return "class";
  }
  return "other";
}

/** Segments annotations into comment runs plus their optional declaration statement. */
function parseAnnotationUnits(text: string): AnnotationUnit[] {
  const lines = text.split(/\r?\n/);
  const units: AnnotationUnit[] = [];
  let index = 0;

  const push = (doc: string[], decl: string[] | null): void => {
    const first = decl?.[0] ?? null;
    units.push({
      doc,
      decl,
      key: memberKeyOf(first),
      receiver: receiverOf(first),
      owner: realmOfDocBlock(doc),
      realm: "shared",
      kind: kindOf(first),
    });
  };

  while (index < lines.length) {
    const doc: string[] = [];
    while (
      index < lines.length &&
      (lines[index]!.startsWith("---") || lines[index]!.trim() === "")
    ) {
      if (lines[index]!.startsWith("---")) {
        doc.push(lines[index]!);
      } else if (doc.length > 0) {
        push(doc.splice(0, doc.length), null);
      }
      index += 1;
    }
    if (index >= lines.length) {
      if (doc.length > 0) {
        push(doc, null);
      }
      break;
    }
    const decl = [lines[index]!];
    index += 1;
    if (/=\s*\{$/.test(decl[0]!)) {
      while (index < lines.length && lines[index]!.trim() !== "}") {
        decl.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) {
        decl.push(lines[index]!);
        index += 1;
      }
    }
    push(doc, decl);
  }
  return units;
}

/** Realm of each class/global table declared in the file, keyed by name. */
function classRealmsOf(units: AnnotationUnit[]): Map<string, RealmPassName> {
  const realms = new Map<string, RealmPassName>();
  for (const unit of units) {
    if (unit.kind === "class" && unit.owner && unit.receiver) {
      realms.set(unit.receiver, unit.owner);
    }
  }
  return realms;
}

/**
 * Classes whose instances or members clearly exist on both sides (for example `Weapon`,
 * declared server-only but with 35 shared instance methods) keep their unmarked members
 * available everywhere, because dropping them would flag legitimate client-side scripts.
 */
function crossRealmClasses(units: AnnotationUnit[]): Set<string> {
  const classRealms = classRealmsOf(units);
  const crossRealm = new Set<string>();
  for (const unit of units) {
    if ((unit.kind !== "static" && unit.kind !== "instance") || !unit.owner || !unit.receiver) {
      continue;
    }
    const classRealm = classRealms.get(unit.receiver);
    if (!classRealm || classRealm === "shared") {
      continue;
    }
    const sharedInstance = unit.kind === "instance" && unit.owner === "shared";
    const oppositeRealm = unit.owner !== "shared" && unit.owner !== classRealm;
    if (sharedInstance || oppositeRealm) {
      crossRealm.add(unit.receiver);
    }
  }
  return crossRealm;
}

/** Realm of every member key that carries an explicit marker somewhere in the file. */
function markedMemberRealms(units: AnnotationUnit[]): Map<string, RealmPassName> {
  const realms = new Map<string, RealmPassName>();
  for (const unit of units) {
    if (unit.key && unit.owner) {
      const previous = realms.get(unit.key);
      realms.set(unit.key, previous && previous !== unit.owner ? "shared" : unit.owner);
    }
  }
  return realms;
}

/** Emits the units owned by `realm`, keeping shared types available to both sides. */
function renderRealm(units: AnnotationUnit[], realm: RealmPassName): string {
  const classRealms = classRealmsOf(units);
  const emittedClasses = new Set<string>();
  const instanceMembersInRealm = new Set<string>();

  for (const unit of units) {
    if (unit.kind !== "instance" || !unit.receiver) {
      continue;
    }
    if (unit.realm === realm || unit.realm === "shared") {
      instanceMembersInRealm.add(unit.receiver);
    }
  }
  for (const unit of units) {
    if (unit.kind !== "class" || !unit.receiver) {
      continue;
    }
    const classRealm = classRealms.get(unit.receiver) ?? unit.realm;
    if (
      classRealm === realm ||
      classRealm === "shared" ||
      instanceMembersInRealm.has(unit.receiver)
    ) {
      emittedClasses.add(unit.receiver);
    }
  }

  const lines: string[] = [];
  for (const unit of units) {
    const realmOwnsUnit = unit.realm === realm || unit.realm === "shared";
    if (unit.kind === "comment") {
      lines.push(...unit.doc);
      continue;
    }
    if (unit.kind === "class") {
      if (emittedClasses.has(unit.receiver ?? "")) {
        lines.push(...unit.doc, ...(unit.decl ?? []));
      }
      continue;
    }
    const receiverKnown = unit.receiver !== null && classRealms.has(unit.receiver);
    if (realmOwnsUnit && (!receiverKnown || emittedClasses.has(unit.receiver!))) {
      lines.push(...unit.doc, ...(unit.decl ?? []));
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Splits a nanos world `annotations.lua` into realm-scoped libraries (#15).
 *
 * Upstream marks every declaration with a side image, so the split is data-driven:
 * `both`/`authority` stay in every realm, `client-only` and `server-only` are restricted
 * to their own realm, unmarked declarations inherit their class or sibling member realm,
 * and a realm-specific class table is dropped from the other realm unless it still has
 * instance members there.
 */
export function splitAnnotationsByRealm(text: string): { client: string; server: string } {
  const units = parseAnnotationUnits(text);
  const classRealms = classRealmsOf(units);
  const crossRealm = crossRealmClasses(units);
  const memberRealms = markedMemberRealms(units);

  for (const unit of units) {
    if (unit.owner) {
      unit.realm = unit.owner;
      continue;
    }
    const markedSibling = unit.key ? memberRealms.get(unit.key) : undefined;
    if (markedSibling) {
      unit.realm = markedSibling;
      continue;
    }
    const classRealm = unit.receiver ? classRealms.get(unit.receiver) : undefined;
    unit.realm =
      classRealm && classRealm !== "shared" && !crossRealm.has(unit.receiver!)
        ? classRealm
        : "shared";
  }

  return { client: renderRealm(units, "client"), server: renderRealm(units, "server") };
}

export interface DerivedRealmAnnotations {
  client: string;
  server: string;
}

/** Cache directory holding realm-split libraries derived from one annotations revision. */
function getRealmAnnotationsCacheDir(annotationsPath: string): string {
  const resolved = path.resolve(annotationsPath);
  let stamp = `${resolved}`;
  try {
    const stat = fs.statSync(resolved);
    stamp = `${resolved}|${stat.size}|${stat.mtimeMs}`;
  } catch (err) {
    logger.debug(
      `[realms] Could not stat annotations at ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const digest = crypto.createHash("sha256").update(stamp).digest("hex").slice(0, 16);
  return path.join(systemPaths.cache, "realms", digest);
}

/**
 * Derives `annotations.client.lua` and `annotations.server.lua` from the resolved
 * annotations file, caching them under the system cache keyed by the source revision.
 * A concurrent derivation is safe: files are written atomically (#7).
 */
export function deriveRealmAnnotationFiles(
  annotationsPath: string,
  cacheDir?: string,
): DerivedRealmAnnotations {
  const targetDir = cacheDir ?? getRealmAnnotationsCacheDir(annotationsPath);
  const clientPath = path.join(targetDir, "annotations.client.lua");
  const serverPath = path.join(targetDir, "annotations.server.lua");

  if (fs.existsSync(clientPath) && fs.existsSync(serverPath)) {
    return { client: clientPath, server: serverPath };
  }

  const source = fs.readFileSync(annotationsPath, "utf-8");
  const split = splitAnnotationsByRealm(source);
  fs.mkdirSync(targetDir, { recursive: true });
  writeAtomicFileSync(clientPath, split.client);
  writeAtomicFileSync(serverPath, split.server);
  logger.debug(`[realms] Derived realm annotations in ${targetDir}.`);
  return { client: clientPath, server: serverPath };
}
