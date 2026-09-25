import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createLauncher,
  assemblePackageDir,
  createReleaseArchive,
  verifyReleaseArchive,
  canCreateZip,
} from "../../scripts/packaging/bundle.js";
import { PACKAGE_TARGETS } from "../../scripts/packaging/types.js";

describe("bundle and launcher operations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanos-pkg-bundle-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  it("createLauncher produces Windows cmd and Unix shell scripts", () => {
    const winDir = path.join(tmpDir, "pkg-win");
    const unixDir = path.join(tmpDir, "pkg-unix");
    fs.mkdirSync(winDir, { recursive: true });
    fs.mkdirSync(unixDir, { recursive: true });

    const winLauncher = createLauncher(winDir, "windows");
    const unixLauncher = createLauncher(unixDir, "linux");

    expect(fs.existsSync(winLauncher)).toBe(true);
    expect(fs.readFileSync(winLauncher, "utf-8")).toContain("dist\\cli.js");

    expect(fs.existsSync(unixLauncher)).toBe(true);
    expect(fs.readFileSync(unixLauncher, "utf-8")).toContain("dist/cli.js");
  });

  it("assemblePackageDir copies required assets and validates layout", () => {
    const pkgDir = path.join(tmpDir, "pkg-windows");
    const extractedLuals = path.join(tmpDir, "luals-extracted");
    const repoMock = path.join(tmpDir, "repo");

    fs.mkdirSync(path.join(extractedLuals, "bin"), { recursive: true });
    fs.writeFileSync(path.join(extractedLuals, "bin", "lua-language-server.exe"), "dummy");
    fs.mkdirSync(path.join(extractedLuals, "locale"), { recursive: true });
    fs.mkdirSync(path.join(extractedLuals, "meta"), { recursive: true });
    fs.mkdirSync(path.join(extractedLuals, "script"), { recursive: true });
    fs.writeFileSync(path.join(extractedLuals, "main.lua"), "-- main");

    fs.mkdirSync(path.join(repoMock, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(repoMock, "dist", "cli.js"),
      "if (process.argv.includes('--help')) process.exit(0);\n",
    );
    fs.mkdirSync(path.join(repoMock, "templates"), { recursive: true });
    fs.writeFileSync(path.join(repoMock, "package.json"), "{}");

    const annotationsPath = path.join(tmpDir, "annotations.lua");
    fs.writeFileSync(annotationsPath, "-- annotations");

    const target = PACKAGE_TARGETS[0]!;
    assemblePackageDir({
      pkgDir,
      extractedLualsDir: extractedLuals,
      target,
      annotationsPath,
      repoRoot: repoMock,
    });

    expect(fs.existsSync(path.join(pkgDir, "bin", "lua-language-server.exe"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "locale"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "meta"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "script"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "main.lua"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "annotations.lua"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "nanos-lint.cmd"))).toBe(true);
  });

  it("assemblePackageDir throws if required LuaLS content set entry is missing", () => {
    const pkgDir = path.join(tmpDir, "pkg-windows");
    const extractedLuals = path.join(tmpDir, "luals-missing-meta");
    const repoMock = path.join(tmpDir, "repo");

    fs.mkdirSync(path.join(extractedLuals, "bin"), { recursive: true });
    fs.writeFileSync(path.join(extractedLuals, "bin", "lua-language-server.exe"), "dummy");
    fs.mkdirSync(path.join(extractedLuals, "locale"), { recursive: true });
    // Intentionally omit meta/
    fs.mkdirSync(path.join(extractedLuals, "script"), { recursive: true });
    fs.writeFileSync(path.join(extractedLuals, "main.lua"), "-- main");

    fs.mkdirSync(path.join(repoMock, "dist"), { recursive: true });
    fs.writeFileSync(path.join(repoMock, "dist", "cli.js"), "process.exit(0);\n");
    fs.mkdirSync(path.join(repoMock, "templates"), { recursive: true });

    const annotationsPath = path.join(tmpDir, "annotations.lua");
    fs.writeFileSync(annotationsPath, "-- annotations");

    const target = PACKAGE_TARGETS[0]!;
    expect(() =>
      assemblePackageDir({
        pkgDir,
        extractedLualsDir: extractedLuals,
        target,
        annotationsPath,
        repoRoot: repoMock,
      }),
    ).toThrow(/required LuaLS asset 'meta' is missing/);
  });

  it.skipIf(!canCreateZip())(
    "createReleaseArchive packages and verifyReleaseArchive validates zip members",
    async () => {
      const pkgDir = path.join(tmpDir, "test-pkg-zip");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "file1.txt"), "content1");
      fs.writeFileSync(path.join(pkgDir, "file2.txt"), "content2");

      const zipOut = path.join(tmpDir, "output.zip");
      await createReleaseArchive(pkgDir, zipOut, "zip");
      expect(fs.existsSync(zipOut)).toBe(true);
      await expect(verifyReleaseArchive(zipOut)).resolves.not.toThrow();
    },
  );

  it("createReleaseArchive packages and verifyReleaseArchive validates tar.gz members", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg-tar");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "file1.txt"), "content1");
    fs.writeFileSync(path.join(pkgDir, "file2.txt"), "content2");

    const tarOut = path.join(tmpDir, "output.tar.gz");
    await createReleaseArchive(pkgDir, tarOut, "tar.gz");
    expect(fs.existsSync(tarOut)).toBe(true);
    await expect(verifyReleaseArchive(tarOut)).resolves.not.toThrow();
  });
});
