import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  readonly "continue-on-error"?: boolean;
  readonly "env"?: Record<string, string>;
  readonly "id"?: string;
  readonly "if"?: string;
  readonly "uses"?: string;
  readonly "with"?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | string[];
  readonly steps: WorkflowStep[];
}

interface Workflow {
  readonly on: {
    readonly release: { readonly types: string[] };
  };
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, WorkflowJob>;
}

interface ReleaseTag {
  readonly name: string;
  readonly commit: { readonly sha: string };
}

const RELEASE_DECISION_SCRIPT = resolve(".github/scripts/decide-major-tag.mjs");

function workflow(): Workflow {
  return parse(
    readFileSync(".github/workflows/release.yml", "utf8"),
  ) as Workflow;
}

function decideRelease(releaseTag: string, tags: ReleaseTag[]): string {
  const directory = mkdtempSync(join(tmpdir(), "prek-autofix-release-"));
  const tagsFile = join(directory, "tags.json");
  const releasesFile = join(directory, "releases.json");
  writeFileSync(tagsFile, JSON.stringify([tags]));
  writeFileSync(
    releasesFile,
    JSON.stringify([
      tags
        .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag.name))
        .map((tag) => ({
          tag_name: tag.name,
          draft: false,
          prerelease: false,
          published_at: "2026-01-01T00:00:00Z",
        })),
    ]),
  );
  try {
    return execFileSync(process.execPath, [RELEASE_DECISION_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_TAG: releaseTag,
        TARGET_SHA:
          tags.find((tag) => tag.name === releaseTag)?.commit.sha ?? "",
        TAGS_FILE: tagsFile,
        RELEASES_FILE: releasesFile,
      },
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function prepareRelease(
  releaseTag: string,
  packageVersion: string,
): {
  output: string;
  packageJson: { version: string };
  packageLock: { version: string; packages: { "": { version: string } } };
} {
  const directory = mkdtempSync(
    join(tmpdir(), "prek-autofix-prepare-release-"),
  );
  const packagePath = join(directory, "package.json");
  const lockPath = join(directory, "package-lock.json");
  const outputPath = join(directory, "output");
  writeFileSync(packagePath, JSON.stringify({ version: packageVersion }));
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: packageVersion,
      packages: { "": { version: packageVersion } },
    }),
  );
  try {
    try {
      execFileSync(
        process.execPath,
        [resolve(".github/scripts/prepare-release.mjs")],
        {
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputPath,
            PACKAGE_JSON_PATH: packagePath,
            PACKAGE_LOCK_PATH: lockPath,
            RELEASE_TAG: releaseTag,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(
        stderr?.toString().trim() || "release preparation failed",
        {
          cause: error,
        },
      );
    }
    return {
      output: readFileSync(outputPath, "utf8"),
      packageJson: JSON.parse(readFileSync(packagePath, "utf8")),
      packageLock: JSON.parse(readFileSync(lockPath, "utf8")),
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("release workflow", () => {
  it("uses a published release with separated candidate and promotion permissions", () => {
    const releaseWorkflow = workflow();
    expect(releaseWorkflow.on.release.types).toEqual(["published"]);
    expect(releaseWorkflow.permissions).toEqual({ contents: "read" });
    expect(releaseWorkflow.jobs.candidate?.if).toContain(
      "github.event.release.prerelease == false",
    );
    expect(releaseWorkflow.jobs.release?.if).toContain("always()");
    expect(releaseWorkflow.jobs.prerelease?.if).toContain(
      "github.event.release.prerelease == true",
    );

    const checkouts = Object.values(releaseWorkflow.jobs).flatMap((job) =>
      job.steps.filter((step) => step.uses?.startsWith("actions/checkout@")),
    );
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("keeps the privileged release job dependent on a completed candidate", () => {
    const releaseJob = workflow().jobs.release;
    const candidateArtifact = workflow().jobs.candidate?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const candidateDownload = releaseJob?.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );

    expect(candidateArtifact?.with?.["if-no-files-found"]).toBe("error");
    expect(candidateDownload?.with?.name).toContain("release-candidate-");
    expect(releaseJob?.needs).toBe("candidate");
  });

  it.each([
    ["v2.0.3", "2.0.2", "2.0.3", "v2"],
    ["v2.1.0-beta.2", "2.1.0-beta.1", "2.1.0-beta.2", "v2"],
  ] as const)(
    "prepares package metadata for %s",
    (releaseTag, currentVersion, expectedVersion, majorTag) => {
      const prepared = prepareRelease(releaseTag, currentVersion);

      expect(prepared.output).toMatch(
        new RegExp(`^major-tag=${majorTag}\\nsource-sha=[0-9a-f]{40}\\n$`),
      );
      expect(prepared.packageJson.version).toBe(expectedVersion);
      expect(prepared.packageLock.version).toBe(expectedVersion);
      expect(prepared.packageLock.packages[""].version).toBe(expectedVersion);
    },
  );

  it.each([
    ["v2.0.1", "2.0.2", /downgrade/u],
    ["v2", "2.0.2", /vMAJOR\.MINOR\.PATCH/u],
  ] as const)(
    "rejects invalid release preparation for %s",
    (tag, version, error) => {
      expect(() => prepareRelease(tag, version)).toThrow(error);
    },
  );

  it.each([
    [
      "create",
      [
        { name: "v1.9.9", commit: { sha: "1".repeat(40) } },
        { name: "v1.10.0", commit: { sha: "2".repeat(40) } },
      ],
      `create\t${"2".repeat(40)}`,
    ],
    [
      "update",
      [
        { name: "v1", commit: { sha: "1".repeat(40) } },
        { name: "v1.9.9", commit: { sha: "1".repeat(40) } },
        { name: "v1.10.0", commit: { sha: "2".repeat(40) } },
      ],
      `update\t${"2".repeat(40)}\t${"1".repeat(40)}`,
    ],
    [
      "no-op",
      [
        { name: "v1", commit: { sha: "2".repeat(40) } },
        { name: "v1.10.0", commit: { sha: "2".repeat(40) } },
      ],
      "noop\t",
    ],
    [
      "skip",
      [
        { name: "v1", commit: { sha: "3".repeat(40) } },
        { name: "v1.10.0", commit: { sha: "2".repeat(40) } },
        { name: "v1.11.0", commit: { sha: "3".repeat(40) } },
      ],
      "skip\t",
    ],
  ] as const)(
    "returns the observable major-tag %s decision",
    (_, tags, expected) => {
      expect(decideRelease("v1.10.0", [...tags])).toBe(expected);
    },
  );
});
