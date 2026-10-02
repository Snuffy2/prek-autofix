import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageMetadata from "../../package.json";
import { versionBanner } from "../../packages/shared/src/version";

describe("versionBanner", () => {
  it("formats the package version", () => {
    expect(versionBanner()).toBe(
      `prek-autofix version v${packageMetadata.version}`,
    );
  });

  it.each(["collect", "apply"])(
    "%s reports a shipped version change without rebuilding the bundle",
    (action) => {
      const directory = mkdtempSync(join(tmpdir(), "prek-version-"));
      try {
        const bundleDirectory = join(directory, "dist", action);
        mkdirSync(bundleDirectory, { recursive: true });
        cpSync(
          resolve("dist", action, "index.js"),
          join(bundleDirectory, "index.js"),
        );
        writeFileSync(
          join(directory, "package.json"),
          JSON.stringify({ ...packageMetadata, version: "9.8.7" }),
        );
        const result = spawnSync(
          process.execPath,
          [join(bundleDirectory, "index.js")],
          {
            cwd: directory,
            encoding: "utf8",
            // Fail before external I/O; the startup banner still runs.
            env: {
              PATH: process.env.PATH,
              GITHUB_EVENT_NAME: "version-test",
              GITHUB_REPOSITORY: "owner/repository",
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.stdout).toContain("prek-autofix version v9.8.7");
      } finally {
        rmSync(directory, { recursive: true });
      }
    },
  );
});
