import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  readonly "continue-on-error"?: boolean;
  readonly "env"?: Record<string, string>;
  readonly "id"?: string;
  readonly "if"?: string;
  readonly "name"?: string;
  readonly "run"?: string;
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
const PREPARE_RELEASE_SCRIPT = resolve(".github/scripts/prepare-release.mjs");

function releaseCandidateWorkspace(): string {
  const directory = mkdtempSync(
    join(tmpdir(), "prek-autofix-candidate-build-"),
  );
  for (const path of [".gitignore", "package.json", "package-lock.json"]) {
    cpSync(resolve(path), join(directory, path));
  }
  for (const path of ["dist", "packages"]) {
    cpSync(resolve(path), join(directory, path), { recursive: true });
  }
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: directory,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: directory });
  return directory;
}

function nextReleaseTag(directory: string): string {
  const packageMetadata: unknown = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  const version =
    typeof packageMetadata === "object" &&
    packageMetadata !== null &&
    typeof (packageMetadata as { version?: unknown }).version === "string"
      ? (packageMetadata as { version: string }).version
      : undefined;
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.exec(
      version ?? "",
    );
  if (!match) {
    throw new Error("candidate package version must use semantic versioning");
  }
  return `v${match[1]}.${match[2]}.${BigInt(match[3]!) + 1n}`;
}

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

type ReleaseUpdateAction = "create" | "noop" | "skip" | "update";
type ReleaseUpdateFailure =
  | "create-race"
  | "major-race"
  | "none"
  | "point-mismatch"
  | "release-tag-move"
  | "release-tag-move-at-push";

interface ReleaseUpdateResult {
  readonly error: Error | undefined;
  readonly initialMajorDirectOid: string | undefined;
  readonly initialMajorSha: string | undefined;
  readonly majorDirectOid: string | undefined;
  readonly majorSha: string | undefined;
  readonly newerSha: string;
  readonly targetSha: string;
}

function runReleaseUpdate(
  action: ReleaseUpdateAction,
  failure: ReleaseUpdateFailure = "none",
  annotatedMajor = false,
  staleListedPointSha = false,
  annotatedPoint = true,
): ReleaseUpdateResult {
  const directory = mkdtempSync(join(tmpdir(), "prek-autofix-release-write-"));
  const remote = join(directory, "remote.git");
  const workspace = join(directory, "workspace");
  const binDirectory = join(directory, "bin");
  const ghPath = join(binDirectory, "gh");
  const gitPath = join(binDirectory, "git");
  const pointReadsPath = join(directory, "point-reads");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const runGit = (arguments_: string[]): string =>
    execFileSync(realGit, arguments_, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const remoteOid = (ref: string): string | undefined => {
    try {
      return runGit(["--git-dir", remote, "rev-parse", "--verify", ref]);
    } catch {
      return undefined;
    }
  };
  try {
    mkdirSync(binDirectory);
    execFileSync(realGit, ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync(realGit, ["init", "--initial-branch=main", workspace], {
      stdio: "ignore",
    });
    runGit(["config", "user.name", "Release test"]);
    runGit(["config", "user.email", "test@example.invalid"]);
    runGit(["remote", "add", "origin", remote]);
    const commit = (message: string): string => {
      writeFileSync(join(workspace, "version"), `${message}\n`);
      runGit(["add", "version"]);
      runGit(["commit", "-m", message]);
      return runGit(["rev-parse", "HEAD"]);
    };
    const oldSha = commit("old release");
    const targetSha = commit("target release");
    const newerSha = commit("newer release");
    const raceSha = commit("racing update");
    const pointSha = failure === "point-mismatch" ? raceSha : targetSha;

    runGit(["tag", "v1.9.9", oldSha]);
    runGit(
      annotatedPoint
        ? ["tag", "-a", "v1.10.0", "-m", "Release v1.10.0", pointSha]
        : ["tag", "v1.10.0", pointSha],
    );
    if (action === "skip") {
      runGit(["tag", "-a", "v1.11.0", "-m", "Release v1.11.0", newerSha]);
    }
    if (action !== "create") {
      const majorSha =
        action === "skip" ? newerSha : action === "noop" ? targetSha : oldSha;
      runGit(
        annotatedMajor
          ? ["tag", "-a", "v1", "-m", "Moving v1", majorSha]
          : ["tag", "v1", majorSha],
      );
    }
    runGit(["push", "origin", "HEAD:refs/heads/main"]);
    runGit(["push", "origin", "refs/tags/v1.9.9", "refs/tags/v1.10.0"]);
    if (action === "skip") runGit(["push", "origin", "refs/tags/v1.11.0"]);
    if (action !== "create") runGit(["push", "origin", "refs/tags/v1"]);

    const initialMajorDirectOid = remoteOid("refs/tags/v1");
    const initialMajorSha =
      remoteOid("refs/tags/v1^{}") ?? initialMajorDirectOid;
    const listedPointSha = staleListedPointSha ? oldSha : targetSha;
    const tags = [
      ...(action === "create"
        ? []
        : [
            {
              name: "v1",
              commit: {
                sha:
                  action === "skip"
                    ? newerSha
                    : action === "noop"
                      ? targetSha
                      : oldSha,
              },
            },
          ]),
      { name: "v1.9.9", commit: { sha: oldSha } },
      { name: "v1.10.0", commit: { sha: listedPointSha } },
      ...(action === "skip"
        ? [{ name: "v1.11.0", commit: { sha: newerSha } }]
        : []),
    ];
    const releases = tags
      .filter((tag) => tag.name !== "v1")
      .map((tag) => ({
        tag_name: tag.name,
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      }));
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"tags?per_page=100"* ]]; then
  printf '%s' "$TAGS_JSON"
elif [[ "$*" == *"releases?per_page=100"* ]]; then
  printf '%s' "$RELEASES_JSON"
else
  printf 'unexpected gh call: %s\\n' "$*" >&2
  exit 2
fi
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(
      gitPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "ls-remote" && "$*" == *"refs/tags/$RELEASE_TAG"* ]]; then
  count=0
  [[ ! -f "$POINT_READS_PATH" ]] || read -r count < "$POINT_READS_PATH"
  ((count += 1))
  printf '%s\\n' "$count" > "$POINT_READS_PATH"
  if [[ "$FAILURE" == "release-tag-move" && "$count" -ge 2 ]]; then
    "$REAL_GIT" --git-dir="$REMOTE_PATH" update-ref "refs/tags/$RELEASE_TAG" "$RACE_SHA"
  fi
elif [[ "$1" == "push" ]]; then
  if [[ "$FAILURE" == "release-tag-move-at-push" ]]; then
    "$REAL_GIT" --git-dir="$REMOTE_PATH" update-ref "refs/tags/$RELEASE_TAG" "$RACE_SHA"
  fi
  if [[ "$FAILURE" == "major-race" || "$FAILURE" == "create-race" ]]; then
    "$REAL_GIT" --git-dir="$REMOTE_PATH" update-ref "refs/tags/$MAJOR_TAG" "$RACE_SHA"
  fi
fi
exec "$REAL_GIT" "$@"
`,
    );
    chmodSync(gitPath, 0o755);

    let error: Error | undefined;
    try {
      execFileSync("bash", [resolve(".github/scripts/update-major-tag.sh")], {
        cwd: workspace,
        env: {
          ...process.env,
          FAILURE: failure,
          GITHUB_REPOSITORY: "owner/repository",
          MAJOR_TAG: "v1",
          PATH: `${binDirectory}:${process.env.PATH}`,
          POINT_READS_PATH: pointReadsPath,
          RACE_SHA: raceSha,
          REAL_GIT: realGit,
          RELEASES_JSON: JSON.stringify([releases]),
          RELEASE_TAG: "v1.10.0",
          REMOTE_PATH: remote,
          TAGS_JSON: JSON.stringify([tags]),
          TARGET_SHA: targetSha,
        },
        stdio: "pipe",
      });
    } catch (caught) {
      const failureOutput = caught as {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      error = new Error(
        failureOutput.stderr?.toString().trim() ||
          failureOutput.stdout?.toString().trim() ||
          "release update failed",
        { cause: caught },
      );
    }
    return {
      error,
      initialMajorDirectOid,
      initialMajorSha,
      majorDirectOid: remoteOid("refs/tags/v1"),
      majorSha: remoteOid("refs/tags/v1^{}") ?? remoteOid("refs/tags/v1"),
      newerSha,
      targetSha,
    };
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

  it("completes a bumped release candidate with regenerated bundles", () => {
    const candidateBuild = workflow().jobs.candidate?.steps.find(
      (step) => step.name === "Build and validate the release candidate",
    );
    const commands = candidateBuild?.run;
    const prepare = "node .github/scripts/prepare-release.mjs";
    const build = "npm run build";
    const stage =
      "git add -- dist/apply/index.js dist/collect/index.js package-lock.json package.json";
    const checkDist = "npm run check:dist";

    expect(commands).toBeDefined();
    expect(commands!.indexOf(prepare)).toBeGreaterThan(-1);
    expect(commands!.indexOf(build)).toBeGreaterThan(
      commands!.indexOf(prepare),
    );
    expect(commands!.indexOf(stage)).toBeGreaterThan(commands!.indexOf(build));
    expect(commands!.indexOf(checkDist)).toBeGreaterThan(
      commands!.indexOf(stage),
    );

    const directory = releaseCandidateWorkspace();
    try {
      const releaseTag = nextReleaseTag(directory);
      execFileSync(process.execPath, [PREPARE_RELEASE_SCRIPT], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_OUTPUT: join(directory, ".git", "github-output"),
          RELEASE_TAG: releaseTag,
        },
      });
      execFileSync("npm", ["run", "build"], { cwd: directory });
      execFileSync(
        "git",
        [
          "add",
          "--",
          "dist/apply/index.js",
          "dist/collect/index.js",
          "package-lock.json",
          "package.json",
        ],
        { cwd: directory },
      );
      execFileSync("npm", ["run", "check:dist"], { cwd: directory });

      expect(
        execFileSync("git", ["diff", "--cached", "--name-only"], {
          cwd: directory,
          encoding: "utf8",
        }),
      ).toBe(
        "dist/apply/index.js\ndist/collect/index.js\npackage-lock.json\npackage.json\n",
      );
      expect(
        execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
          cwd: directory,
          encoding: "utf8",
        }),
      ).toBe("");
    } finally {
      rmSync(directory, { recursive: true });
    }
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

  it.each([
    ["lightweight", false],
    ["annotated", true],
  ] as const)(
    "updates an existing %s moving tag through a real Git remote",
    (_kind, annotated) => {
      const result = runReleaseUpdate("update", "none", annotated);

      expect(result.error).toBeUndefined();
      expect(result.initialMajorSha).not.toBe(result.targetSha);
      expect(result.majorSha).toBe(result.targetSha);
      expect(result.majorDirectOid).toBe(result.targetSha);
    },
  );

  it("creates a missing moving tag through a real Git remote", () => {
    const result = runReleaseUpdate("create");

    expect(result.error).toBeUndefined();
    expect(result.initialMajorSha).toBeUndefined();
    expect(result.majorSha).toBe(result.targetSha);
  });

  it.each(["update", "create"] as const)(
    "handles a lightweight finalized tag during a %s decision",
    (action) => {
      const result = runReleaseUpdate(action, "none", false, false, false);

      expect(result.error).toBeUndefined();
      expect(result.majorSha).toBe(result.targetSha);
    },
  );

  it.each(["noop", "skip"] as const)(
    "leaves the moving tag unchanged for a %s decision",
    (action) => {
      const result = runReleaseUpdate(action);

      expect(result.error).toBeUndefined();
      expect(result.majorSha).toBe(result.initialMajorSha);
      if (action === "skip") expect(result.majorSha).toBe(result.newerSha);
    },
  );

  it("accepts a stale paginated SHA after verifying the exact remote tag", () => {
    const result = runReleaseUpdate("create", "none", false, true);

    expect(result.error).toBeUndefined();
    expect(result.majorSha).toBe(result.targetSha);
  });

  it("fails closed when the exact finalized release ref does not match", () => {
    const result = runReleaseUpdate("update", "point-mismatch");

    expect(result.error?.message).toMatch(
      /does not match its exact finalized tag ref/u,
    );
    expect(result.majorSha).toBe(result.initialMajorSha);
  });

  it.each([
    ["update", "major-race"],
    ["create", "create-race"],
  ] as const)(
    "rejects a competing %s through the real Git lease",
    (action, failure) => {
      const result = runReleaseUpdate(action, failure, action === "update");

      expect(result.error).toBeDefined();
      expect(result.majorSha).not.toBe(result.targetSha);
    },
  );

  it.each(["update", "create", "noop", "skip"] as const)(
    "rejects release-tag movement before completing a %s decision",
    (action) => {
      const result = runReleaseUpdate(action, "release-tag-move");

      expect(result.error?.message).toMatch(
        /changed while its update was being prepared/u,
      );
      expect(result.majorSha).toBe(result.initialMajorSha);
    },
  );

  it.each([
    ["update", true],
    ["create", false],
  ] as const)(
    "restores the moving tag when the release tag moves during a %s push",
    (action, annotated) => {
      const result = runReleaseUpdate(
        action,
        "release-tag-move-at-push",
        annotated,
      );

      expect(result.error?.message).toMatch(
        /changed while its update was being prepared/u,
      );
      expect(result.majorSha).toBe(result.initialMajorSha);
      expect(result.majorDirectOid).toBe(result.initialMajorDirectOid);
    },
  );
});
