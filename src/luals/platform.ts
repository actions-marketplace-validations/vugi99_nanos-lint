import path from "node:path";
import { FALLBACK_LUALS_VERSION } from "./version.js";
import { LuaLSError } from "../errors.js";

export interface PlatformInfo {
  platform: "win32" | "linux" | "darwin";
  arch: "x64" | "arm64" | "ia32";
  assetName: string;
  binaryRelativePath: string;
}

/** Resolves platform-specific binary naming and relative paths for the host operating system. */
export function getPlatformInfo(version: string = FALLBACK_LUALS_VERSION): PlatformInfo {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    if (arch === "x64") {
      return {
        platform: "win32",
        arch: "x64",
        assetName: `lua-language-server-${version}-win32-x64.zip`,
        binaryRelativePath: path.join("bin", "lua-language-server.exe"),
      };
    }
    throw new LuaLSError(
      `Unsupported Windows architecture: ${arch}. Supported: x64`,
      "ERR_LUALS_UNSUPPORTED_ARCH",
      "LuaLS provides pre-built binaries for Windows x64. Use a compatible system or set LUALS_BIN to a custom binary."
    );
  }

  if (platform === "linux") {
    if (arch === "x64") {
      return {
        platform: "linux",
        arch: "x64",
        assetName: `lua-language-server-${version}-linux-x64.tar.gz`,
        binaryRelativePath: path.join("bin", "lua-language-server"),
      };
    }
    if (arch === "arm64") {
      return {
        platform: "linux",
        arch: "arm64",
        assetName: `lua-language-server-${version}-linux-arm64.tar.gz`,
        binaryRelativePath: path.join("bin", "lua-language-server"),
      };
    }
    throw new LuaLSError(
      `Unsupported Linux architecture: ${arch}. Supported: x64, arm64`,
      "ERR_LUALS_UNSUPPORTED_ARCH",
      "LuaLS provides pre-built binaries for Linux x64 and arm64. Use LUALS_BIN to specify a custom build."
    );
  }

  if (platform === "darwin") {
    const archName = arch === "arm64" ? "arm64" : "x64";
    return {
      platform: "darwin",
      arch: arch as "x64" | "arm64",
      assetName: `lua-language-server-${version}-darwin-${archName}.tar.gz`,
      binaryRelativePath: path.join("bin", "lua-language-server"),
    };
  }

  throw new LuaLSError(
    `Unsupported platform: ${platform}`,
    "ERR_LUALS_UNSUPPORTED_PLATFORM",
    "LuaLS provides pre-built binaries for Windows, Linux, and macOS. Use LUALS_BIN to specify a custom build."
  );
}

