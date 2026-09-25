import path from "node:path";

export type TargetArchitecture = "x64" | "arm64";
export type TargetOs = "windows" | "linux" | "macos";
export type ArchiveFormat = "zip" | "tar.gz";

export interface PackageTargetConfig {
  id: string;
  os: TargetOs;
  arch: TargetArchitecture;
  archiveFormat: ArchiveFormat;
  lualsAssetName: (version: string) => string;
  binRelativePath: string;
  binName: string;
  expectedArch: TargetArchitecture;
  pkgDirName: string;
  outputArchiveName: (tag: string) => string;
}

export const PACKAGE_TARGETS: readonly PackageTargetConfig[] = [
  {
    id: "windows-x64",
    os: "windows",
    arch: "x64",
    archiveFormat: "zip",
    lualsAssetName: (ver) => `lua-language-server-${ver}-win32-x64.zip`,
    binRelativePath: path.join("bin", "lua-language-server.exe"),
    binName: "lua-language-server.exe",
    expectedArch: "x64",
    pkgDirName: "pkg-windows",
    outputArchiveName: (tag) => `nanos-lint-${tag}-windows-x64.zip`,
  },
  {
    id: "linux-x64",
    os: "linux",
    arch: "x64",
    archiveFormat: "tar.gz",
    lualsAssetName: (ver) => `lua-language-server-${ver}-linux-x64.tar.gz`,
    binRelativePath: path.join("bin", "lua-language-server"),
    binName: "lua-language-server",
    expectedArch: "x64",
    pkgDirName: "pkg-linux",
    outputArchiveName: (tag) => `nanos-lint-${tag}-linux-x64.tar.gz`,
  },
  {
    id: "linux-arm64",
    os: "linux",
    arch: "arm64",
    archiveFormat: "tar.gz",
    lualsAssetName: (ver) => `lua-language-server-${ver}-linux-arm64.tar.gz`,
    binRelativePath: path.join("bin", "lua-language-server"),
    binName: "lua-language-server",
    expectedArch: "arm64",
    pkgDirName: "pkg-linux-arm64",
    outputArchiveName: (tag) => `nanos-lint-${tag}-linux-arm64.tar.gz`,
  },
  {
    id: "macos-arm64",
    os: "macos",
    arch: "arm64",
    archiveFormat: "tar.gz",
    lualsAssetName: (ver) => `lua-language-server-${ver}-darwin-arm64.tar.gz`,
    binRelativePath: path.join("bin", "lua-language-server"),
    binName: "lua-language-server",
    expectedArch: "arm64",
    pkgDirName: "pkg-macos-arm64",
    outputArchiveName: (tag) => `nanos-lint-${tag}-macos-arm64.tar.gz`,
  },
  {
    id: "macos-x64",
    os: "macos",
    arch: "x64",
    archiveFormat: "tar.gz",
    lualsAssetName: (ver) => `lua-language-server-${ver}-darwin-x64.tar.gz`,
    binRelativePath: path.join("bin", "lua-language-server"),
    binName: "lua-language-server",
    expectedArch: "x64",
    pkgDirName: "pkg-macos-x64",
    outputArchiveName: (tag) => `nanos-lint-${tag}-macos-x64.tar.gz`,
  },
];
