import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

export function sanitizeAnnotations(content: string): string {
  // 1. Fix Issue #20: Multiline default values in @param definitions
  // Strictly match unclosed (Default: {\n ... \n})
  let sanitized = content.replace(
    /(\(Default:\s*\{\s*\r?\n)([\s\S]*?)(\r?\n\}\))/g,
    (_match, header, body, _footer) => {
      const commentedBody = body
        .split(/\r?\n/)
        .map((line: string) => {
          if (line.trim().length === 0) return line;
          return line.startsWith("---") ? line : `---${line}`;
        })
        .join("\n");
      return `${header}${commentedBody}\n---})`;
    }
  );

  // 2. Fix invalid vararg return type: any... -> any
  sanitized = sanitized.replace(/---@return\s+any\.\.\./g, "---@return any");

  // 3. Prepend aliases for missing/improper types
  const preamble = [
    "---@meta",
    "--",
    "-- Sanitized nanos-world Lua 5.4 annotations",
    "-- Generated and patched by nanos-lint",
    "--",
    "---@alias bool boolean",
    "---@alias iterator any",
    "---@alias Text3DAlignCamera integer|any",
    "---@alias Text3DBevelType integer|any",
    "---@alias Text3DHorizontalAlignment integer|any",
    "---@alias Text3DVerticalAlignment integer|any",
    "",
  ].join("\n");

  return preamble + sanitized;
}

export async function syncAnnotations(): Promise<void> {
  const submodulePath = path.join(
    ROOT_DIR,
    "vendor",
    "nanos-world-vscode-extension",
    "annotations.lua"
  );
  const outputPath = path.join(ROOT_DIR, "definitions", "annotations.lua");

  let rawContent: string;

  if (fs.existsSync(submodulePath)) {
    console.log(`[sync] Reading annotations from submodule: ${submodulePath}`);
    rawContent = fs.readFileSync(submodulePath, "utf-8");
  } else {
    console.log("[sync] Submodule not found, fetching from GitHub...");
    const url =
      "https://raw.githubusercontent.com/nanos-world/vscode-extension/docgen-output/annotations.lua";
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch annotations from ${url}: ${res.statusText}`);
    }
    rawContent = await res.text();
  }

  console.log("[sync] Sanitizing annotations (patching Issue #20)...");
  const sanitized = sanitizeAnnotations(rawContent);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, sanitized, "utf-8");
  console.log(`[sync] Saved sanitized annotations to: ${outputPath}`);
}

// Execute if run directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  syncAnnotations().catch((err) => {
    console.error("[sync] Error:", err);
    process.exit(1);
  });
}
