import { describe, expect, it } from "vitest";
import packageMetadata from "../../package.json";
import { versionBanner } from "../../packages/shared/src/version";

describe("versionBanner", () => {
  it("formats the embedded package version", () => {
    expect(versionBanner()).toBe(
      `prek-autofix version v${packageMetadata.version}`,
    );
  });
});
