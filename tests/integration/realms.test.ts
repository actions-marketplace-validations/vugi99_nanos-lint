import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getPackageRoot, loadUserConfig } from "../../src/config.js";
import {
  planRealmCheck,
  runRealmAwareCheck,
  splitAnnotationsByRealm,
  type RealmCheckPlan,
  type RealmSelection,
} from "../../src/realms.js";
import { fileUriToPath } from "../../src/types.js";
import { getSharedAnnotations, isLiveTestsEnabled } from "../helpers/live.js";

const fixturesRoot = path.join(getPackageRoot(), "tests", "fixtures");

interface RealmRun {
  plan: RealmCheckPlan | null;
  lines: string[];
  codes: string[];
  passed: boolean;
  filesChecked: number;
}

let annotationsPath = "";

/** Runs the realm planner for a fixture and flattens the report into `file:line` strings. */
async function runFixture(fixture: string, selection: RealmSelection = "all"): Promise<RealmRun> {
  const root = path.join(fixturesRoot, fixture);
  const plan = planRealmCheck({
    targetPath: root,
    userConfig: loadUserConfig(root),
    selection,
    annotationsPath,
  });
  if (!plan) {
    return { plan: null, lines: [], codes: [], passed: true, filesChecked: 0 };
  }
  try {
    const result = await runRealmAwareCheck(plan, root, {
      path: root,
      checklevel: "Warning",
      format: "json",
    });
    const lines: string[] = [];
    const codes: string[] = [];
    for (const [uri, diagnostics] of Object.entries(result.diagnostics)) {
      const relative = path.relative(root, path.resolve(fileUriToPath(uri))).replace(/\\/g, "/");
      for (const diagnostic of diagnostics) {
        lines.push(`${relative}:${diagnostic.range.start.line + 1} ${diagnostic.message}`);
        codes.push(`${relative}:${diagnostic.code}`);
      }
    }
    return {
      plan,
      lines,
      codes,
      passed: result.passed,
      filesChecked: result.totalFilesChecked ?? 0,
    };
  } finally {
    plan.cleanup();
  }
}

describe.skipIf(!isLiveTestsEnabled())("realm-aware checking (#15)", () => {
  beforeAll(async () => {
    annotationsPath = await getSharedAnnotations();
  }, 120000);

  afterEach(() => {
    expect(fs.existsSync(annotationsPath)).toBe(true);
  });

  it("plans strict server, strict client and full-context shared passes", async () => {
    const run = await runFixture("realms");

    expect(run.plan?.passes.map((pass) => pass.realm)).toEqual(["server", "client", "shared"]);
    expect(run.passed).toBe(false);
    expect(run.codes).toContain("Server/combat.lua:undefined-global");
    expect(run.codes).toContain("Client/hud.lua:undefined-global");
    expect(run.lines.join("\n")).toContain("Undefined global `Client`.");
    expect(run.lines.join("\n")).toContain("Undefined global `Server`.");
  });

  it("isolates globals defined in Client from Server scripts", async () => {
    const run = await runFixture("realms");

    const serverLines = run.lines.filter((line) => line.startsWith("Server/combat.lua"));
    expect(serverLines.join("\n")).toContain("Undefined global `ClientSideState`.");
  });

  it("does not report a guarded side-specific call inside Shared", async () => {
    const run = await runFixture("realms");

    expect(run.lines.some((line) => line.startsWith("Shared/bridge.lua"))).toBe(false);
    expect(run.passed).toBe(false);
  });

  it("merges the passes without duplicating diagnostics", async () => {
    const run = await runFixture("realms");

    const duplicates = run.lines.filter((entry, index) => run.lines.indexOf(entry) !== index);
    expect(duplicates).toEqual([]);
    expect(run.filesChecked).toBe(4);
    expect(run.lines).toHaveLength(3);
  });

  it("accepts a clean package that respects realm boundaries", async () => {
    const run = await runFixture("realms_clean");

    expect(run.passed).toBe(true);
    expect(run.lines).toEqual([]);
    expect(run.plan?.passes.map((pass) => pass.realm)).toEqual(["server", "client", "shared"]);
    expect(run.filesChecked).toBe(5);
  });

  it("honours custom nanos.realms mappings and keeps unmatched files full-context", async () => {
    const run = await runFixture("realms_custom");

    expect(run.plan?.passes.map((pass) => pass.realm)).toEqual(["server", "client", "shared"]);
    expect(run.lines.join("\n")).toContain("src/server/logic.lua:2");
    expect(run.lines.join("\n")).toContain("src/client/logic.lua:2");
    expect(run.lines.some((line) => line.startsWith("ServerLegacy/legacy.lua"))).toBe(false);
    expect(run.lines.some((line) => line.startsWith("common/util.lua"))).toBe(false);
  });

  it("falls back to a single standard pass when nanos.realms is empty", async () => {
    const run = await runFixture("realms_disabled");

    expect(run.plan).toBeNull();
  });

  it("limits --realm client to the client and shared files", async () => {
    const run = await runFixture("realms", "client");

    expect(run.plan?.passes.map((pass) => pass.realm)).toEqual(["shared", "client"]);
    expect(run.lines.join("\n")).toContain("Client/hud.lua");
    expect(run.lines.some((line) => line.startsWith("Server/"))).toBe(false);
    expect(run.filesChecked).toBe(3);
  });

  it("limits --realm shared to the full-context pass", async () => {
    const run = await runFixture("realms", "shared");

    expect(run.plan?.passes.map((pass) => pass.realm)).toEqual(["shared"]);
    expect(run.passed).toBe(true);
    expect(run.filesChecked).toBe(2);
  });

  it("restricts client-only APIs in the server realm and vice versa", async () => {
    const split = splitAnnotationsByRealm(fs.readFileSync(annotationsPath, "utf-8"));

    expect(split.client).toContain("function Client.GetLocalPlayer()");
    expect(split.server).toContain("function Server.ChangeMap(");
    expect(split.client).not.toContain("function Server.ChangeMap(");
    expect(split.server).not.toContain("function Client.GetLocalPlayer()");
    expect(split.client).toContain("function Weapon:GetAmmoClip()");
    expect(split.server).toContain("function Weapon:GetAmmoClip()");
  });
});
