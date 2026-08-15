import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

async function metadata(path: string): Promise<Record<string, any>> {
  return parse(await readFile(resolve(path), "utf8"));
}

const RELEASE_DECISION_SCRIPT = resolve(".github/scripts/decide-major-tag.mjs");

function decideRelease(
  script: string,
  releaseTag: string,
  targetSha: string,
  tags: Array<{ name: string; commit: { sha: string } }>,
  releases: Array<{
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }> = tags
    .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag.name))
    .map((tag) => ({
      tag_name: tag.name,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    })),
): string {
  const directory = mkdtempSync(join(tmpdir(), "prek-autofix-release-"));
  const tagsFile = join(directory, "tags.json");
  const releasesFile = join(directory, "releases.json");
  writeFileSync(tagsFile, JSON.stringify([tags.slice(0, 1), tags.slice(1)]));
  writeFileSync(
    releasesFile,
    JSON.stringify([releases.slice(0, 1), releases.slice(1)]),
  );
  try {
    return execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_TAG: releaseTag,
        TARGET_SHA: targetSha,
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
          cwd: resolve("."),
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
        { cause: error },
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

function runPrepareReleaseShell(failingCommand: string): void {
  const directory = mkdtempSync(join(tmpdir(), "prek-autofix-prepare-shell-"));
  const gitPath = join(directory, "git");
  for (const command of ["node", "npm"]) {
    const path = join(directory, command);
    writeFileSync(path, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(path, 0o755);
  }
  writeFileSync(
    gitPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "$FAILING_COMMAND" ]]; then
  exit 1
fi
case "$*" in
"status --porcelain"|"diff --check"|"diff --name-only"|"ls-files --others --exclude-standard"|"add -- dist/apply/index.js dist/collect/index.js package-lock.json package.json")
  exit 0
  ;;
esac
printf 'unexpected git call: %s\n' "$*" >&2
exit 2
`,
  );
  chmodSync(gitPath, 0o755);
  try {
    execFileSync("bash", [resolve(".github/scripts/prepare-release.sh")], {
      cwd: resolve("."),
      env: {
        ...process.env,
        FAILING_COMMAND: failingCommand,
        PATH: `${directory}:${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    throw new Error(stderr?.toString().trim() || "release preparation failed", {
      cause: error,
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function runReleaseUpdate(
  releaseTag: string,
  targetSha: string,
  tags: Array<{ name: string; commit: { sha: string } }>,
  releases: Array<{
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }>,
  failure: "none" | "release-tag-move" | "create-race" = "none",
  directRefOid?: string,
  pointRefOid = targetSha,
  tagCycle: "none" | "point" | "major" = "none",
): string {
  const directory = mkdtempSync(join(tmpdir(), "prek-autofix-release-write-"));
  const ghPath = join(directory, "gh");
  const sleepPath = join(directory, "sleep");
  const callsPath = join(directory, "calls");
  const releaseMatch =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(releaseTag);
  if (!releaseMatch) {
    throw new Error("release update fixture requires a valid release tag");
  }
  const majorTag = `v${releaseMatch[1]}`;
  const tagsJson = JSON.stringify([tags]);
  const releasesJson = JSON.stringify([releases]);
  const movingTagCommitSha =
    tags.find((tag) => tag.name === majorTag)?.commit.sha ?? "";
  const observedDirectRefOid = directRefOid ?? movingTagCommitSha;
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS_PATH"
if [[ "$*" == *"tags?per_page=100"* ]]; then
  printf '%s' "$TAGS_JSON"
elif [[ "$*" == *"releases?per_page=100"* ]]; then
  printf '%s' "$RELEASES_JSON"
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG --jq .object | [.sha, .type] | @tsv" ]]; then
  if [[ "$TAG_CYCLE" == "point" ]]; then
    printf '%s\ttag\n' "$POINT_REF_OID"
  else
    printf '%s\tcommit\n' "$POINT_REF_OID"
  fi
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/ref/tags/$MAJOR_TAG --jq .object | [.sha, .type] | @tsv" ]]; then
  printf '%s\\t%s\\n' "$DIRECT_REF_OID" "$DIRECT_REF_TYPE"
elif [[ "$TAG_CYCLE" == "point" && "$*" == "api repos/$GITHUB_REPOSITORY/git/tags/$POINT_REF_OID --jq .object | [.sha, .type] | @tsv" ]]; then
  peel_calls="$(grep -c '/git/tags/' "$CALLS_PATH")"
  [[ "$peel_calls" -le 16 ]] || exit 3
  printf '%s\\ttag\\n' "$POINT_REF_OID"
elif [[ "$TAG_CYCLE" == "major" && "$*" == api\\ repos/$GITHUB_REPOSITORY/git/tags/* ]]; then
  peel_calls="$(grep -c '/git/tags/' "$CALLS_PATH")"
  [[ "$peel_calls" -le 16 ]] || exit 3
  object_oid="\${2##*/}"
  printf '%s\\ttag\\n' "$object_oid"
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/tags/$DIRECT_REF_OID --jq .object | [.sha, .type] | @tsv" ]]; then
  printf '%s\\tcommit\\n' "$MOVING_TAG_COMMIT_SHA"
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY --jq .node_id" ]]; then
  printf '%s\\n' 'R_repo_node'
elif [[ "$*" == api\\ graphql* ]]; then
  [[ "$FAILURE" != "release-tag-move" && "$FAILURE" != "create-race" ]] || exit 1
  printf '%s\\n' '{"data":{"updateRefs":{"clientMutationId":null}}}'
else
  printf 'unexpected gh call: %s\\n' "$*" >&2
  exit 2
fi
`,
  );
  chmodSync(ghPath, 0o755);
  writeFileSync(sleepPath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(sleepPath, 0o755);
  try {
    try {
      execFileSync("bash", [resolve(".github/scripts/update-major-tag.sh")], {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CALLS_PATH: callsPath,
          TAGS_JSON: tagsJson,
          RELEASES_JSON: releasesJson,
          DIRECT_REF_OID: observedDirectRefOid,
          DIRECT_REF_TYPE: directRefOid === undefined ? "commit" : "tag",
          MAJOR_TAG: majorTag,
          MOVING_TAG_COMMIT_SHA: movingTagCommitSha,
          POINT_REF_OID: pointRefOid,
          TAG_CYCLE: tagCycle,
          FAILURE: failure,
          GITHUB_REPOSITORY: "owner/repository",
          GITHUB_WORKSPACE: resolve("."),
          RELEASE_TAG: releaseTag,
          TARGET_SHA: targetSha,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(stderr?.toString().trim() || "release update failed", {
        cause: error,
      });
    }
    return readFileSync(callsPath, "utf8");
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("action metadata", () => {
  it("keeps the primary and nested review actions synchronized", async () => {
    const primaryAction = await metadata("action.yml");
    const reviewAction = await metadata("review/action.yml");

    for (const action of [primaryAction, reviewAction]) {
      expect(action.inputs).toEqual(primaryAction.inputs);
      expect(action.outputs).toEqual(primaryAction.outputs);
    }
    expect(primaryAction.runs.using).toBe(reviewAction.runs.using);
    expect(primaryAction.runs.steps).toEqual(
      reviewAction.runs.steps.map((step: Record<string, any>) =>
        step.id === "review"
          ? {
              ...step,
              run: 'node "$GITHUB_ACTION_PATH/dist/collect/index.js"',
            }
          : step,
      ),
    );
  });

  it("does not expose the autofix mutation token to the review action", async () => {
    const action = await metadata("review/action.yml");
    expect(action.inputs).not.toHaveProperty("autofix-token");
  });

  it("uploads a persisted artifact before propagating collection failure", async () => {
    const action = await metadata("review/action.yml");
    const review = action.runs.steps.find(
      (step: Record<string, any>) => step.id === "review",
    );
    const upload = action.runs.steps.find(
      (step: Record<string, any>) => step.id === "upload",
    );
    const propagate = action.runs.steps.find(
      (step: Record<string, any>) => step.id === "propagate",
    );

    expect(review["continue-on-error"]).toBe(true);
    expect(upload).toMatchObject({
      id: "upload",
      if: "steps.review.outputs.artifact-name != ''",
      with: {
        "name": "${{ steps.review.outputs.artifact-name }}",
        "path": "${{ steps.review.outputs.artifact-path }}",
        "if-no-files-found": "error",
      },
    });
    expect(propagate).toMatchObject({
      id: "propagate",
      if: "steps.review.outcome == 'failure'",
      shell: "bash",
      run: "exit 1",
    });
    expect(action.runs.steps.indexOf(upload)).toBeLessThan(
      action.runs.steps.indexOf(propagate),
    );
  });

  it("uses an isolated Node 24 privileged entry point", async () => {
    const action = await metadata("fix/action.yml");
    expect(action.runs).toMatchObject({
      using: "node24",
      main: "../dist/apply/index.js",
    });
    expect(action.inputs["github-token"]).toMatchObject({
      required: false,
      default: "${{ github.token }}",
    });
    expect(action.inputs["autofix-token"].required).toBe(true);
  });

  it("updates package metadata to the published release version", () => {
    const prepared = prepareRelease("v1.0.8", "1.0.7");

    expect(prepared.output).toMatch(
      /^major-tag=v1\nsource-sha=[0-9a-f]{40}\n$/,
    );
    expect(prepared.packageJson.version).toBe("1.0.8");
    expect(prepared.packageLock.version).toBe("1.0.8");
    expect(prepared.packageLock.packages[""].version).toBe("1.0.8");
    expect(() => prepareRelease("v1.0.6", "1.0.7")).toThrow(/downgrade/u);
    expect(() => prepareRelease("v1", "1.0.7")).toThrow(
      /vMAJOR\.MINOR\.PATCH/u,
    );
  });

  it("fails closed when release path collection commands fail", () => {
    expect(() => runPrepareReleaseShell("diff --name-only")).toThrow(
      "Unable to collect changed release paths",
    );
    expect(() =>
      runPrepareReleaseShell("ls-files --others --exclude-standard"),
    ).toThrow("Unable to collect untracked release paths");
  });

  it("keeps release credentials scoped to write-capable jobs", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    const jobs: Record<
      string,
      { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }
    > = workflow.jobs;
    const checkouts = Object.values(jobs).flatMap((job) =>
      (job.steps ?? []).filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      ),
    );

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.finalize.permissions).toEqual({
      actions: "read",
      contents: "write",
    });
    expect(workflow.jobs["update-major"].permissions).toEqual({
      contents: "write",
    });
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("isolates release source from trusted tooling during preparation", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    const steps: Array<{
      "id"?: string;
      "run"?: string;
      "uses"?: string;
      "with"?: Record<string, unknown>;
      "working-directory"?: string;
    }> = workflow.jobs.prepare.steps;
    const releaseCheckout = steps.find(
      (step) =>
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.ref === "${{ github.event.release.tag_name }}",
    );
    const toolingCheckout = steps.find(
      (step) =>
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.ref === "${{ github.workflow_sha }}",
    );
    const install = steps.find((step) => step.run?.startsWith("npm ci"));
    const preparation = steps.find((step) => step.id === "release");
    const upload = steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );

    expect(releaseCheckout?.with).toMatchObject({
      "path": "release",
      "persist-credentials": false,
    });
    expect(toolingCheckout?.with).toMatchObject({
      "path": "tooling",
      "persist-credentials": false,
    });
    expect(install).toMatchObject({
      "run": "npm ci --ignore-scripts",
      "working-directory": "release",
    });
    expect(preparation).toMatchObject({
      "run": "bash ../tooling/.github/scripts/prepare-release.sh",
      "working-directory": "release",
    });
    expect(upload?.with?.path).toBe(
      "release/dist/apply/index.js\n" +
        "release/dist/collect/index.js\n" +
        "release/package-lock.json\n" +
        "release/package.json\n",
    );
  });

  it("keeps moving major tags monotonic across releases and reruns", () => {
    const script = RELEASE_DECISION_SCRIPT;
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const newerSha = "3".repeat(40);

    expect(
      decideRelease(script, "v1.10.0", targetSha, [
        { name: "v1.9.9", commit: { sha: oldSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ]),
    ).toBe(`create\t${targetSha}`);
    expect(
      decideRelease(script, "v1.10.0", targetSha, [
        { name: "v1", commit: { sha: oldSha } },
        { name: "v1.9.9", commit: { sha: oldSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ]),
    ).toBe(`update\t${targetSha}\t${oldSha}`);
    expect(
      decideRelease(script, "v1.10.12", targetSha, [
        { name: "v1", commit: { sha: oldSha } },
        { name: "v1.10.9", commit: { sha: oldSha } },
        { name: "v1.10.12", commit: { sha: targetSha } },
      ]),
    ).toBe(`update\t${targetSha}\t${oldSha}`);
    expect(
      decideRelease(script, "v1.10.0", targetSha, [
        { name: "v1", commit: { sha: targetSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ]),
    ).toBe("noop\t");
    expect(
      decideRelease(script, "v1.10.0", targetSha, [
        { name: "v1", commit: { sha: newerSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
        { name: "v1.11.0", commit: { sha: newerSha } },
      ]),
    ).toBe("skip\t");
  });

  it("promotes only the triggering release verified by the read-only job", () => {
    const script = RELEASE_DECISION_SCRIPT;
    const oldSha = "1".repeat(40);
    const triggeringSha = "2".repeat(40);
    const unverifiedNewerSha = "3".repeat(40);
    const tags = [
      { name: "v1", commit: { sha: oldSha } },
      { name: "v1.9.9", commit: { sha: oldSha } },
      { name: "v1.10.0", commit: { sha: triggeringSha } },
      { name: "v1.11.0", commit: { sha: unverifiedNewerSha } },
    ];

    expect(decideRelease(script, "v1.10.0", triggeringSha, tags)).toBe(
      `update\t${triggeringSha}\t${oldSha}`,
    );
  });

  it("allows a surviving verified pending job to advance after replacement", () => {
    const script = RELEASE_DECISION_SCRIPT;
    const oldSha = "1".repeat(40);
    const runningSha = "2".repeat(40);
    const replacedPendingSha = "3".repeat(40);
    const survivingPendingSha = "4".repeat(40);
    const tagsBeforeRunningUpdate = [
      { name: "v1", commit: { sha: oldSha } },
      { name: "v1.9.9", commit: { sha: oldSha } },
      { name: "v1.10.0", commit: { sha: runningSha } },
      { name: "v1.11.0", commit: { sha: replacedPendingSha } },
      { name: "v1.12.0", commit: { sha: survivingPendingSha } },
    ];

    expect(
      decideRelease(script, "v1.10.0", runningSha, tagsBeforeRunningUpdate),
    ).toBe(`update\t${runningSha}\t${oldSha}`);

    const tagsAfterRunningUpdate = tagsBeforeRunningUpdate.map((tag) =>
      tag.name === "v1" ? { ...tag, commit: { sha: runningSha } } : tag,
    );
    expect(
      decideRelease(
        script,
        "v1.12.0",
        survivingPendingSha,
        tagsAfterRunningUpdate,
      ),
    ).toBe(`update\t${survivingPendingSha}\t${runningSha}`);
  });

  it("uses an annotated moving tag's direct ref OID in the exact CAS update", () => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const annotatedTagOid = "a".repeat(40);
    const releases = ["v1.9.9", "v1.10.0"].map((tagName) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    }));
    const calls = runReleaseUpdate(
      "v1.10.0",
      targetSha,
      [
        { name: "v1", commit: { sha: oldSha } },
        { name: "v1.9.9", commit: { sha: oldSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ],
      releases,
      "none",
      annotatedTagOid,
    );

    expect(calls).toContain(`-f releaseOid=${targetSha}`);
    expect(calls).toContain("beforeOid: $releaseOid");
    expect(calls).toContain("afterOid: $releaseOid");
    expect(calls).toContain(`-f majorBeforeOid=${annotatedTagOid}`);
    expect(calls).not.toContain(`-f majorBeforeOid=${oldSha}`);
    expect(calls).toContain(`-f majorAfterOid=${targetSha}`);
  });

  it("bounds annotated release-tag peeling", () => {
    const targetSha = "2".repeat(40);

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [],
        "none",
        undefined,
        "a".repeat(40),
        "point",
      ),
    ).toThrow(/maximum peel depth/u);
  });

  it("bounds annotated moving-tag peeling", () => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [
          { name: "v1", commit: { sha: oldSha } },
          { name: "v1.9.9", commit: { sha: oldSha } },
          { name: "v1.10.0", commit: { sha: targetSha } },
        ],
        ["v1.9.9", "v1.10.0"].map((tagName) => ({
          tag_name: tagName,
          draft: false,
          prerelease: false,
          published_at: "2026-01-01T00:00:00Z",
        })),
        "none",
        "a".repeat(40),
        targetSha,
        "major",
      ),
    ).toThrow(/maximum peel depth/u);
  });

  it("fails closed when the exact finalized release ref does not match", () => {
    const targetSha = "2".repeat(40);

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [],
        "none",
        undefined,
        "3".repeat(40),
      ),
    ).toThrow(/does not match its exact finalized tag ref/u);
  });

  it("atomically rejects release-tag movement before updating the major tag", () => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const releases = ["v1.9.9", "v1.10.0"].map((tagName) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    }));

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [
          { name: "v1", commit: { sha: oldSha } },
          { name: "v1.9.9", commit: { sha: oldSha } },
          { name: "v1.10.0", commit: { sha: targetSha } },
        ],
        releases,
        "release-tag-move",
      ),
    ).toThrow();
  });

  it("uses absence CAS and rejects a competing major-tag creation", () => {
    const targetSha = "2".repeat(40);
    const releases = [
      {
        tag_name: "v1.10.0",
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      },
    ];

    const calls = runReleaseUpdate(
      "v1.10.0",
      targetSha,
      [{ name: "v1.10.0", commit: { sha: targetSha } }],
      releases,
    );
    expect(calls).toContain(
      'beforeOid: "0000000000000000000000000000000000000000"',
    );
    expect(calls).toContain(`-f releaseOid=${targetSha}`);

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        releases,
        "create-race",
      ),
    ).toThrow();
  });

  it("fails closed when moving-tag monotonicity cannot be proven", () => {
    const script = RELEASE_DECISION_SCRIPT;
    const targetSha = "2".repeat(40);

    expect(() =>
      decideRelease(script, "v2.10.12", targetSha, [
        { name: "v2", commit: { sha: "f".repeat(40) } },
        { name: "v2.10.12", commit: { sha: targetSha } },
      ]),
    ).toThrow(/known finalized stable release/);
  });

  it("trusts the exact release ref over a stale paginated tag SHA", () => {
    const script = RELEASE_DECISION_SCRIPT;
    const targetSha = "2".repeat(40);

    expect(
      decideRelease(script, "v2.10.12", targetSha, [
        { name: "v2.10.12", commit: { sha: "e".repeat(40) } },
      ]),
    ).toBe(`create\t${targetSha}`);
  });

  it("ignores tags without a successfully published stable release", () => {
    const script = RELEASE_DECISION_SCRIPT;
    const targetSha = "2".repeat(40);
    const futureSha = "3".repeat(40);
    const tags = [
      { name: "v1.10.0", commit: { sha: targetSha } },
      { name: "v1.11.0", commit: { sha: futureSha } },
      { name: "v1.12.0", commit: { sha: futureSha } },
      { name: "v1.13.0", commit: { sha: futureSha } },
    ];
    const releases = [
      {
        tag_name: "v1.10.0",
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      },
      {
        tag_name: "v1.12.0",
        draft: true,
        prerelease: false,
        published_at: null,
      },
      {
        tag_name: "v1.13.0",
        draft: false,
        prerelease: true,
        published_at: "2026-01-02T00:00:00Z",
      },
    ];

    expect(decideRelease(script, "v1.10.0", targetSha, tags, releases)).toBe(
      `create\t${targetSha}`,
    );
  });

  it("requires the triggering release and every eligible release to match a tag", () => {
    const script = RELEASE_DECISION_SCRIPT;
    const targetSha = "2".repeat(40);
    const published = (tagName: string) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    });

    expect(() =>
      decideRelease(
        script,
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [
          {
            ...published("v1.10.0"),
            prerelease: true,
          },
        ],
      ),
    ).toThrow(/not a published stable release/);
    expect(() =>
      decideRelease(
        script,
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [published("v1.10.0"), published("v1.11.0")],
      ),
    ).toThrow(/has no matching tag/);
  });
});
