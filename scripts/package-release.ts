import fs from "node:fs";
import path from "node:path";
import { PACKAGE_TARGETS } from "./packaging/types.js";
import {
  safeExtractArchive,
  verifyExtractedTreeInvariants,
  downloadAssetHardened,
} from "./packaging/verify.js";
import { assemblePackageDir, createReleaseArchive } from "./packaging/bundle.js";
import { fetchLatestCommitId, fetchRawAnnotationsContent } from "../src/annotations-download.js";
import {
  MIN_ANNOTATIONS_SIZE_BYTES,
  MAX_ANNOTATIONS_SIZE_BYTES,
} from "../src/annotations-metadata.js";
import { computeFileSha256 } from "../src/luals/download.js";

export function sanitizeTag(tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[^0-9A-Za-z._-]/.test(trimmed)) {
    throw new Error(`Refusing to use invalid or unsafe release tag: '${tag}'`);
  }
  return trimmed;
}

export function sanitizeVersion(version: string): string {
  const trimmed = version.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[^0-9A-Za-z._-]/.test(trimmed)) {
    throw new Error(`Refusing to use invalid or unsafe LuaLS version: '${version}'`);
  }
  return trimmed;
}

export async function resolveLuaLSReleaseVersion(token?: string): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": "nanos-lint" };
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  try {
    const res = await fetch(
      "https://api.github.com/repos/LuaLS/lua-language-server/releases/latest",
      { headers, signal: AbortSignal.timeout(10000) },
    );
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      if (typeof data.tag_name === "string" && data.tag_name) {
        const ver = data.tag_name.replace(/^v/, "");
        return sanitizeVersion(ver);
      }
    }
  } catch (err) {
    console.warn(
      `[release] Failed to query latest LuaLS release from GitHub: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return "3.19.1";
}

export async function resolveAndPinAnnotations(destPath: string): Promise<string> {
  console.log("[release] Resolving latest commit SHA for nanos annotations (docgen-output)...");
  const commitId = await fetchLatestCommitId();
  if (!commitId) {
    throw new Error("Failed to resolve commit SHA for nanos annotations from GitHub API");
  }
  console.log(`[release] Pinned annotations to commit ${commitId}`);

  const content = await fetchRawAnnotationsContent(commitId);
  const size = Buffer.byteLength(content, "utf-8");
  if (size < MIN_ANNOTATIONS_SIZE_BYTES || size > MAX_ANNOTATIONS_SIZE_BYTES) {
    throw new Error(
      `Annotations file size (${size} bytes) is outside permitted bounds [${MIN_ANNOTATIONS_SIZE_BYTES}, ${MAX_ANNOTATIONS_SIZE_BYTES}]`,
    );
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content, "utf-8");
  const sha256 = computeFileSha256(destPath);
  console.log(`[release] Saved verified annotations.lua (SHA-256 ${sha256})`);
  return commitId;
}

export interface PackageReleaseOptions {
  repoRoot?: string;
  targetIds?: string[];
  lualsVersion?: string;
}

export async function packageRelease(
  tagName: string,
  options?: PackageReleaseOptions,
): Promise<{ outputArchives: string[]; sumsPath: string }> {
  const cleanTag = sanitizeTag(tagName);
  const repoRoot = options?.repoRoot ?? process.cwd();
  const token = process.env.GITHUB_TOKEN;

  console.log(`\n=== Starting Release Packaging for tag ${cleanTag} ===\n`);

  const lualsVersion = options?.lualsVersion ?? (await resolveLuaLSReleaseVersion(token));
  console.log(`[release] Using LuaLS release version: ${lualsVersion}`);

  const releaseBuildsDir = path.join(repoRoot, "release-builds");
  fs.mkdirSync(releaseBuildsDir, { recursive: true });

  const workDir = path.join(repoRoot, ".package-release-tmp");
  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  fs.mkdirSync(workDir, { recursive: true });

  const tempAnnotationsPath = path.join(workDir, "annotations.lua");
  const annotationsCommitId = await resolveAndPinAnnotations(tempAnnotationsPath);

  const targets = options?.targetIds
    ? PACKAGE_TARGETS.filter((t) => options.targetIds!.includes(t.id))
    : PACKAGE_TARGETS;

  const outputArchives: string[] = [];
  const checksumLines: string[] = [];

  try {
    for (const target of targets) {
      console.log(`\n--- Packaging Target: ${target.id} ---`);
      const assetName = target.lualsAssetName(lualsVersion);
      const downloadUrl = `https://github.com/LuaLS/lua-language-server/releases/download/${lualsVersion}/${assetName}`;
      const downloadPath = path.join(workDir, assetName);

      console.log(`[release] Downloading ${assetName}...`);
      const archiveSha = await downloadAssetHardened(downloadUrl, downloadPath);
      console.log(`[release] Downloaded ${assetName} (SHA-256 ${archiveSha})`);

      const extractedLualsDir = path.join(workDir, `${target.pkgDirName}-luals`);
      console.log(`[release] Pre-validating and extracting to ${extractedLualsDir}...`);
      await safeExtractArchive(downloadPath, extractedLualsDir);

      console.log(`[release] Verifying extracted tree invariants and binary architecture...`);
      verifyExtractedTreeInvariants(extractedLualsDir, {
        expectedBinName: target.binName,
        expectedArch: target.expectedArch,
      });

      const pkgDir = path.join(workDir, target.pkgDirName);
      console.log(`[release] Assembling distribution package in ${pkgDir}...`);
      assemblePackageDir({
        pkgDir,
        extractedLualsDir,
        target,
        annotationsPath: tempAnnotationsPath,
        repoRoot,
      });

      const archiveName = target.outputArchiveName(cleanTag);
      const archivePath = path.join(releaseBuildsDir, archiveName);
      console.log(`[release] Creating archive: ${archivePath}...`);
      await createReleaseArchive(pkgDir, archivePath, target.archiveFormat);

      await (await import("./packaging/bundle.js")).verifyReleaseArchive(archivePath);

      const archiveStat = fs.statSync(archivePath);
      const createdSha = computeFileSha256(archivePath);
      checksumLines.push(`${createdSha}  ${archiveName}`);
      outputArchives.push(archivePath);
      console.log(
        `[release] Successfully packaged ${archiveName} (${archiveStat.size} bytes, SHA-256 ${createdSha})`,
      );
    }

    const sumsPath = path.join(releaseBuildsDir, "SHA256SUMS");
    const sumsContent = [
      "# nanos-lint release provenance",
      `# Release tag: ${cleanTag}`,
      `# LuaLS version: ${lualsVersion}`,
      `# Annotations commit: ${annotationsCommitId}`,
      "",
      ...checksumLines,
      "",
    ].join("\n");
    fs.writeFileSync(sumsPath, sumsContent, "utf-8");
    console.log(`[release] Generated provenance checksums manifest at ${sumsPath}`);

    console.log("\n=== Release Packaging Completed Successfully ===");
    return { outputArchives, sumsPath };
  } finally {
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
      const leftoverRootAnnotations = path.join(repoRoot, "annotations.lua");
      if (fs.existsSync(leftoverRootAnnotations)) {
        fs.unlinkSync(leftoverRootAnnotations);
      }
    } catch (err) {
      void err;
    }
  }
}

async function main(): Promise<void> {
  let tag = process.env.TAG_NAME || "";
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--tag" && process.argv[i + 1]) {
      tag = process.argv[i + 1]!;
      i++;
    } else if (process.argv[i]?.startsWith("--tag=")) {
      tag = process.argv[i]!.split("=")[1] || "";
    }
  }

  if (!tag) {
    console.error("Error: --tag <name> or TAG_NAME environment variable is required.");
    process.exit(1);
  }

  try {
    await packageRelease(tag);
  } catch (err) {
    console.error(
      `\n[FATAL] Release packaging failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]).endsWith("package-release.ts");
if (isEntry) {
  void main();
}
