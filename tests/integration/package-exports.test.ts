import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getPackageRoot, loadUserConfig } from "../../src/config.js";
import { planRealmCheck, runRealmAwareCheck, type RealmCheckPlan } from "../../src/realms.js";
import { fileUriToPath } from "../../src/types.js";
import { getSharedAnnotations, isLiveTestsEnabled } from "../helpers/live.js";

const fixturesRoot = path.join(getPackageRoot(), "tests", "fixtures");
const consumerRoot = path.join(fixturesRoot, "exports", "consumer");

interface ExportRun {
  lines: string[];
  codes: string[];
  passed: boolean;
}

let annotationsPath = "";

/** Runs the full realm-aware check for the export fixture and flattens its report. */
async function runConsumer(): Promise<ExportRun> {
  const plan: RealmCheckPlan | null = planRealmCheck({
    targetPath: consumerRoot,
    userConfig: loadUserConfig(consumerRoot),
    selection: "all",
    annotationsPath,
  });
  if (!plan) {
    return { lines: [], codes: [], passed: true };
  }
  try {
    const result = await runRealmAwareCheck(plan, consumerRoot, {
      path: consumerRoot,
      checklevel: "Warning",
      format: "json",
    });
    const lines: string[] = [];
    const codes: string[] = [];
    for (const [uri, diagnostics] of Object.entries(result.diagnostics)) {
      const relative = path
        .relative(consumerRoot, path.resolve(fileUriToPath(uri)))
        .replace(/\\/g, "/");
      for (const diagnostic of diagnostics) {
        lines.push(`${relative}:${diagnostic.range.start.line + 1} ${diagnostic.message}`);
        codes.push(`${relative}:${diagnostic.code}`);
      }
    }
    return { lines, codes, passed: result.passed };
  } finally {
    plan.cleanup();
  }
}

describe.skipIf(!isLiveTestsEnabled())("package exported globals (#72)", () => {
  beforeAll(async () => {
    annotationsPath = await getSharedAnnotations();
  }, 120000);

  afterEach(() => {
    expect(fs.existsSync(annotationsPath)).toBe(true);
  });

  it("resolves Package.Export globals in dependency packages without undefined-global", async () => {
    const run = await runConsumer();

    expect(run.codes.filter((code) => code.endsWith(":undefined-global"))).toEqual([]);
    expect(run.lines.filter((line) => line.startsWith("Server/Index.lua"))).toEqual([]);
  });

  it("keeps the exported type shape and signatures for consumer packages", async () => {
    const run = await runConsumer();

    expect(run.codes).toContain("Server/Misuse.lua:undefined-field");
    expect(run.codes).toContain("Server/Misuse.lua:param-type-mismatch");
    expect(run.lines.join("\n")).toContain("ThisDoesNotExist");
    expect(run.lines.join("\n")).toContain("NotAFunction");
    expect(run.lines.join("\n")).toContain("Cannot assign `string` to parameter `Player`");
    expect(run.lines.join("\n")).toContain("Cannot assign `string` to parameter `integer`");
    expect(run.passed).toBe(false);
  });

  it("does not evaluate the exporting package scripts as consumer files", async () => {
    const run = await runConsumer();

    expect(run.lines.some((line) => line.includes("exports/library/"))).toBe(false);
  });
});
