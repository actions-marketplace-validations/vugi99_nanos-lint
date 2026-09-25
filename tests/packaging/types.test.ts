import { describe, it, expect } from "vitest";
import { PACKAGE_TARGETS } from "../../scripts/packaging/types.js";

describe("packaging target definitions", () => {
  it("defines all five supported release platforms", () => {
    const ids = PACKAGE_TARGETS.map((t) => t.id);
    expect(ids).toEqual(["windows-x64", "linux-x64", "linux-arm64", "macos-arm64", "macos-x64"]);
  });

  it("generates correct upstream asset and release archive names for each target", () => {
    for (const target of PACKAGE_TARGETS) {
      expect(target.id).toBeTruthy();
      expect(["windows", "linux", "macos"]).toContain(target.os);
      expect(["x64", "arm64"]).toContain(target.arch);
      expect(["zip", "tar.gz"]).toContain(target.archiveFormat);
      expect(target.binName).toBeTruthy();
      expect(target.binRelativePath).toContain(target.binName);

      const upstreamAsset = target.lualsAssetName("3.19.1");
      expect(upstreamAsset).toContain("3.19.1");
      expect(upstreamAsset.endsWith(`.${target.archiveFormat}`)).toBe(true);

      const releaseArchive = target.outputArchiveName("v2.8.2");
      expect(releaseArchive).toContain("v2.8.2");
      expect(releaseArchive).toContain(target.id);
      expect(releaseArchive.endsWith(`.${target.archiveFormat}`)).toBe(true);
    }
  });
});
