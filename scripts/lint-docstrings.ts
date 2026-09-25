import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { globSync } from "glob";

interface DocstringException {
  minPercentage: number;
  reason: string;
}

const DEFAULT_MIN_PERCENTAGE = 90.0;

const EXCEPTIONS: Record<string, DocstringException> = {
  // If an exception is required, specify normalized relative path:
  // "src/example.ts": {
  //   minPercentage: 80.0,
  //   reason: "Small internal helper utility"
  // }
};

interface FunctionInfo {
  name: string;
  line: number;
  hasDoc: boolean;
}

interface FileDocStats {
  file: string;
  totalFunctions: number;
  documentedFunctions: number;
  coverage: number;
  minAllowed: number;
  passed: boolean;
  undocumented: FunctionInfo[];
  exceptionReason?: string;
}

function hasJSDocComment(node: ts.Node, sourceText: string): boolean {
  const ranges = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];
  for (const range of ranges) {
    if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      const comment = sourceText.slice(range.pos, range.end);
      if (comment.startsWith("/**") && comment.endsWith("*/")) {
        return true;
      }
    }
  }
  return false;
}

export function analyzeDocstringCoverage(filePath: string, content: string): FileDocStats {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const functions: FunctionInfo[] = [];

  function getLine(pos: number): number {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  function visit(node: ts.Node) {
    // 1. Function Declarations (e.g. function foo() {})
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name ? node.name.text : "<anonymous_function>";
      const hasDoc = hasJSDocComment(node, content);
      functions.push({
        name,
        line: getLine(node.getStart(sourceFile)),
        hasDoc,
      });
    }

    // 2. Variable Statements with arrow functions / function expressions
    // Top-level or exported
    else if (ts.isVariableStatement(node)) {
      const isTopLevel = node.parent === sourceFile;
      const isExported = Boolean(
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
      );

      if (isTopLevel || isExported) {
        for (const decl of node.declarationList.declarations) {
          if (
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            const name = ts.isIdentifier(decl.name)
              ? decl.name.text
              : decl.name.getText(sourceFile);
            const hasDoc = hasJSDocComment(node, content) || hasJSDocComment(decl, content);
            functions.push({
              name,
              line: getLine(decl.getStart(sourceFile)),
              hasDoc,
            });
          }
        }
      }
    }

    // 3. Class Method Declarations
    else if (ts.isMethodDeclaration(node)) {
      const name = node.name ? node.name.getText(sourceFile) : "<anonymous_method>";
      const hasDoc = hasJSDocComment(node, content);
      functions.push({
        name,
        line: getLine(node.getStart(sourceFile)),
        hasDoc,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const totalFunctions = functions.length;
  const documentedFunctions = functions.filter((f) => f.hasDoc).length;
  const coverage = totalFunctions === 0 ? 100 : (documentedFunctions / totalFunctions) * 100;

  const normalizedRelPath = filePath.replace(/\\/g, "/");
  const exception = EXCEPTIONS[normalizedRelPath];
  const minAllowed = exception ? exception.minPercentage : DEFAULT_MIN_PERCENTAGE;
  const passed = totalFunctions === 0 || coverage >= minAllowed;

  return {
    file: normalizedRelPath,
    totalFunctions,
    documentedFunctions,
    coverage,
    minAllowed,
    passed,
    undocumented: functions.filter((f) => !f.hasDoc),
    exceptionReason: exception?.reason,
  };
}

export function runDocstringLint(): boolean {
  const files = globSync("src/**/*.ts", {
    ignore: ["**/*.d.ts", "**/node_modules/**"],
  }).map((f) => f.replace(/\\/g, "/"));

  let failed = false;
  const analyzed: FileDocStats[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const stats = analyzeDocstringCoverage(file, content);
    analyzed.push(stats);
    if (!stats.passed) {
      failed = true;
    }
  }

  // Sort ascending by coverage
  analyzed.sort((a, b) => a.coverage - b.coverage);

  console.log("\n--- Docstring Coverage Quality Gate Report ---");
  for (const stat of analyzed) {
    const status = stat.passed ? "PASS" : "FAIL";
    const exceptionText = stat.exceptionReason
      ? ` (Exception: >= ${stat.minAllowed.toFixed(1)}% - ${stat.exceptionReason})`
      : "";
    console.log(
      `[${status}] ${stat.file.padEnd(30)} ${stat.coverage.toFixed(1).padStart(5)}% (${stat.documentedFunctions}/${stat.totalFunctions} functions)${exceptionText}`,
    );
    if (!stat.passed && stat.undocumented.length > 0) {
      for (const u of stat.undocumented) {
        console.log(`       -> Undocumented: ${u.name} (line ${u.line})`);
      }
    }
  }

  if (failed) {
    console.error("\n[ERROR] One or more files in src/ have docstring coverage below 90.0%.");
    return false;
  }

  console.log("\n[SUCCESS] All files satisfy docstring coverage requirements.");
  return true;
}

const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("lint-docstrings.ts"));

if (isMain) {
  const ok = runDocstringLint();
  if (!ok) {
    process.exit(1);
  }
}
