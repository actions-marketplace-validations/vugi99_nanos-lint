import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { globSync } from "glob";

interface CommentGateException {
  maxPercentage: number;
  reason: string;
}

const DEFAULT_MAX_PERCENTAGE = 15.0;
const MIN_LINES_THRESHOLD = 50;

const EXCEPTIONS: Record<string, CommentGateException> = {
  // If an exception is required, specify normalized relative path:
  // "src/luals/files.ts": {
  //   maxPercentage: 20.0,
  //   reason: "Documents ReDoS polynomial backtracking budgets and minimatch combinatorial complexity."
  // }
};

interface FileCommentStats {
  file: string;
  totalLines: number;
  commentLines: number;
  density: number;
  maxAllowed: number;
  passed: boolean;
  exceptionReason?: string;
}

export function analyzeCommentDensity(filePath: string, content: string): FileCommentStats {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }
  const totalLines = lineStarts.length;

  function getLineNumber(pos: number): number {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid]! <= pos) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return high + 1; // 1-indexed line number
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  const linesWithComments = new Set<number>();
  const seenRanges = new Set<string>();

  function collectComments(node: ts.Node) {
    const leading = ts.getLeadingCommentRanges(content, node.getFullStart());
    if (leading) {
      for (const r of leading) {
        const key = `${r.pos}:${r.end}`;
        if (!seenRanges.has(key)) {
          seenRanges.add(key);
          const startLine = getLineNumber(r.pos);
          const endLine = getLineNumber(Math.max(r.pos, r.end - 1));
          for (let l = startLine; l <= endLine; l++) {
            linesWithComments.add(l);
          }
        }
      }
    }
    const trailing = ts.getTrailingCommentRanges(content, node.getEnd());
    if (trailing) {
      for (const r of trailing) {
        const key = `${r.pos}:${r.end}`;
        if (!seenRanges.has(key)) {
          seenRanges.add(key);
          const startLine = getLineNumber(r.pos);
          const endLine = getLineNumber(Math.max(r.pos, r.end - 1));
          for (let l = startLine; l <= endLine; l++) {
            linesWithComments.add(l);
          }
        }
      }
    }
    ts.forEachChild(node, collectComments);
  }

  collectComments(sourceFile);

  // Replace all comment ranges with whitespace of identical length
  let blanked = content;
  const sortedRanges = Array.from(seenRanges)
    .map((k) => {
      const [p, e] = k.split(":").map(Number);
      return { pos: p!, end: e! };
    })
    .sort((a, b) => b.pos - a.pos);

  for (const r of sortedRanges) {
    const len = r.end - r.pos;
    blanked = blanked.slice(0, r.pos) + " ".repeat(len) + blanked.slice(r.end);
  }

  const blankedLines = blanked.split("\n");
  const pureCommentLines = new Set<number>();
  for (const lineNum of linesWithComments) {
    const blankedLine = blankedLines[lineNum - 1] ?? "";
    if (blankedLine.trim().length === 0) {
      pureCommentLines.add(lineNum);
    }
  }

  const commentCount = pureCommentLines.size;
  const density = totalLines > 0 ? (commentCount / totalLines) * 100 : 0;

  const normalizedRelPath = filePath.replace(/\\/g, "/");
  const exception = EXCEPTIONS[normalizedRelPath];
  const maxAllowed = exception ? exception.maxPercentage : DEFAULT_MAX_PERCENTAGE;
  const passed = totalLines < MIN_LINES_THRESHOLD || density <= maxAllowed;

  return {
    file: normalizedRelPath,
    totalLines,
    commentLines: commentCount,
    density,
    maxAllowed,
    passed,
    exceptionReason: exception?.reason,
  };
}

export function runCommentLint(): boolean {
  const files = globSync("{src,tests}/**/*.ts", {
    ignore: ["**/*.d.ts", "**/node_modules/**"],
  }).map((f) => f.replace(/\\/g, "/"));

  let failed = false;
  const analyzed: FileCommentStats[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const stats = analyzeCommentDensity(file, content);
    analyzed.push(stats);
    if (!stats.passed) {
      failed = true;
    }
  }

  // Sort descending by density
  analyzed.sort((a, b) => b.density - a.density);

  console.log("\n--- Comment Density Quality Gate Report ---");
  for (const stat of analyzed) {
    if (stat.totalLines < MIN_LINES_THRESHOLD) {
      continue;
    }
    const status = stat.passed ? "PASS" : "FAIL";
    const exceptionText = stat.exceptionReason ? ` (Exception: <= ${stat.maxAllowed.toFixed(1)}% - ${stat.exceptionReason})` : "";
    console.log(
      `[${status}] ${stat.file.padEnd(35)} ${stat.density.toFixed(1).padStart(5)}% (${stat.commentLines}/${stat.totalLines} lines)${exceptionText}`
    );
  }

  if (failed) {
    console.error("\n[ERROR] One or more files exceeded the comment density limit (<= 15.0%).");
    return false;
  }

  console.log("\n[SUCCESS] All files satisfy comment density requirements.");
  return true;
}

import { fileURLToPath } from "node:url";

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("lint-comments.ts")
);

if (isMain) {
  const ok = runCommentLint();
  if (!ok) {
    process.exit(1);
  }
}
