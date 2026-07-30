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

function releaseDecisionScript(workflow: Record<string, any>): string {
  const run = workflow.jobs["update-major"].steps[0].run as string;
  const match = run.match(/node <<'NODE'\n([\s\S]*?)\nNODE/);
  expect(
    match,
    "release workflow is missing its decision script",
  ).not.toBeNull();
  return match?.[1] ?? "";
}

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
  writeFileSync(tagsFile, JSON.stringify([tags]));
  writeFileSync(releasesFile, JSON.stringify([releases]));
  try {
    return execFileSync(process.execPath, ["-e", script], {
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

function runReleaseUpdate(
  workflow: Record<string, any>,
  releaseTag: string,
  targetSha: string,
  tags: Array<{ name: string; commit: { sha: string } }>,
  releases: Array<{
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }>,
  failure: "none" | "external-move" | "create-race" = "none",
  directRefOid?: string,
): string {
  const directory = mkdtempSync(join(tmpdir(), "prek-autofix-release-write-"));
  const ghPath = join(directory, "gh");
  const callsPath = join(directory, "calls");
  const tagsJson = JSON.stringify([tags]);
  const releasesJson = JSON.stringify([releases]);
  const movingTagCommitSha =
    tags.find((tag) => tag.name === `v${releaseTag.split(".")[0]!.slice(1)}`)
      ?.commit.sha ?? "";
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
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/ref/tags/v1 --jq .object | [.sha, .type] | @tsv" ]]; then
  printf '%s\\t%s\\n' "$DIRECT_REF_OID" "$DIRECT_REF_TYPE"
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/tags/$DIRECT_REF_OID --jq .object | [.sha, .type] | @tsv" ]]; then
  printf '%s\\tcommit\\n' "$MOVING_TAG_COMMIT_SHA"
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY --jq .node_id" ]]; then
  printf '%s\\n' 'R_repo_node'
elif [[ "$*" == api\\ graphql* ]]; then
  [[ "$FAILURE" != "external-move" ]] || exit 1
  printf '%s\\n' '{"data":{"updateRefs":{"clientMutationId":null}}}'
elif [[ "$*" == api\\ --method\\ POST* ]]; then
  [[ "$FAILURE" != "create-race" ]] || exit 1
  printf '%s\\n' '{"ref":"refs/tags/v1"}'
else
  printf 'unexpected gh call: %s\\n' "$*" >&2
  exit 2
fi
`,
  );
  chmodSync(ghPath, 0o755);
  const run = workflow.jobs["update-major"].steps[0].run as string;
  try {
    execFileSync("bash", ["-eo", "pipefail", "-c", run], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        CALLS_PATH: callsPath,
        TAGS_JSON: tagsJson,
        RELEASES_JSON: releasesJson,
        DIRECT_REF_OID: observedDirectRefOid,
        DIRECT_REF_TYPE: directRefOid === undefined ? "commit" : "tag",
        MOVING_TAG_COMMIT_SHA: movingTagCommitSha,
        FAILURE: failure,
        GITHUB_REPOSITORY: "owner/repository",
        RELEASE_TAG: releaseTag,
        TARGET_SHA: targetSha,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      expect(action.name).toBe("prek Autofix Review");
      expect(action.author).toBe("Snuffy2");
      expect(action.description).toBe(
        "Review pull requests with prek and upload any resulting fixes",
      );
      expect(action.inputs).toEqual(primaryAction.inputs);
      expect(action.outputs).toEqual(primaryAction.outputs);
      expect(action.branding).toEqual({
        icon: "check-circle",
        color: "green",
      });
    }
    expect(primaryAction.runs.using).toBe(reviewAction.runs.using);
    expect(primaryAction.runs.steps).toEqual([
      ...reviewAction.runs.steps.slice(0, -1),
      {
        ...reviewAction.runs.steps.at(-1),
        run: 'node "$GITHUB_ACTION_PATH/dist/collect/index.js"',
      },
    ]);
  });

  it("keeps the review action unprivileged and major-tagged", async () => {
    const action = await metadata("review/action.yml");
    expect(Object.keys(action.inputs)).toEqual([
      "prek-version",
      "extra-args",
      "working-directory",
      "cache",
      "max-passes",
      "max-log-bytes",
      "pass-timeout-seconds",
    ]);
    expect(action.inputs["max-passes"].default).toBe("3");
    expect(action.inputs["max-log-bytes"].default).toBe("1048576");
    expect(action.inputs["pass-timeout-seconds"].default).toBe("600");
    expect(action.outputs).toHaveProperty("changed");
    expect(action.outputs).toHaveProperty("artifact-name");
    expect(action.outputs).toHaveProperty("prek-version");
    expect(action.runs.using).toBe("composite");

    const serialized = JSON.stringify(action);
    expect(serialized).toContain("actions/setup-node@v6");
    expect(serialized).toContain("j178/prek-action@v2");
    expect(serialized).toContain(
      "$GITHUB_ACTION_PATH/../dist/collect/index.js",
    );
    expect(serialized).not.toMatch(
      /autofix-token|PREK_AUTOFIX_TOKEN|checkout/i,
    );
  });

  it("uses an isolated Node 24 privileged entry point", async () => {
    const action = await metadata("fix/action.yml");
    expect(action.name).toBe("prek Autofix Fix");
    expect(action.author).toBe("Snuffy2");
    expect(action.runs).toEqual({
      using: "node24",
      main: "../dist/apply/index.js",
    });
    expect(action.inputs["autofix-token"].required).toBe(true);
    expect(action.inputs["commit-message"].default).toBe(
      "[prek-autofix] apply automatic fixes",
    );
    expect(action.inputs["source-workflow"].default).toBe("prek-autofix");
    expect(action.inputs["max-files"].default).toBe("100");
    expect(action.inputs["max-bytes"].default).toBe("10485760");

    const source = await readFile("packages/apply/src/index.ts", "utf8");
    expect(source).not.toMatch(/child_process|spawn\(|exec\(|checkout/);
    expect(source).not.toMatch(/["']git["']/);
  });

  it("ships both bundled entry points", async () => {
    const collectBundle = await readFile("dist/collect/index.js");
    const applyBundle = await readFile("dist/apply/index.js");
    expect(collectBundle.byteLength).toBeGreaterThan(0);
    expect(applyBundle.byteLength).toBeGreaterThan(0);
  });

  it("isolates release verification from repository write credentials", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.verify.steps[0].with["persist-credentials"]).toBe(
      false,
    );
    expect(workflow.jobs["update-major"].permissions).toEqual({
      contents: "write",
    });
    expect(JSON.stringify(workflow.jobs["update-major"])).not.toMatch(
      /npm ci|npm test|checkout|packages\//,
    );
    expect(workflow.jobs["update-major"].concurrency).toEqual({
      "group":
        "release-major-${{ github.repository }}-${{ needs.verify.outputs.major-tag }}",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs.verify.outputs["major-tag"]).toBe(
      "${{ steps.release.outputs.major-tag }}",
    );
    const updateScript = workflow.jobs["update-major"].steps[0].run as string;
    expect(updateScript).toContain("gh api --paginate --slurp");
    expect(updateScript).toContain(
      "repos/$GITHUB_REPOSITORY/releases?per_page=100",
    );
    expect(updateScript).not.toContain("2>/dev/null");
    expect(updateScript).not.toContain("--method PATCH");
    expect(updateScript).toContain("updateRefs");
    expect(updateScript).toContain("beforeOid: \\$beforeOid");
    expect(updateScript).toContain("afterOid: \\$afterOid");
  });

  it("keeps moving major tags monotonic across releases and reruns", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    const script = releaseDecisionScript(workflow);
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

  it("promotes only the triggering release verified by the read-only job", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    const script = releaseDecisionScript(workflow);
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

  it("allows a surviving verified pending job to advance after replacement", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    const script = releaseDecisionScript(workflow);
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

  it("uses an annotated moving tag's direct ref OID in the exact CAS update", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
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
      workflow,
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

    expect(calls).toContain(
      "api repos/owner/repository/git/ref/tags/v1 " +
        "--jq .object | [.sha, .type] | @tsv",
    );
    expect(calls).toContain(
      `api repos/owner/repository/git/tags/${annotatedTagOid} ` +
        "--jq .object | [.sha, .type] | @tsv",
    );
    expect(calls).toContain("api repos/owner/repository --jq .node_id");
    expect(calls).toContain("api graphql");
    expect(calls).toContain("-F repositoryId=R_repo_node");
    expect(calls).toContain("-f name=refs/tags/v1");
    expect(calls).toContain(`-f beforeOid=${annotatedTagOid}`);
    expect(calls).not.toContain(`-f beforeOid=${oldSha}`);
    expect(calls).toContain(`-f afterOid=${targetSha}`);
    expect(calls).toContain("-F force=true");
  });

  it("fails closed when the moving tag changes after observation", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
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
        workflow,
        "v1.10.0",
        targetSha,
        [
          { name: "v1", commit: { sha: oldSha } },
          { name: "v1.9.9", commit: { sha: oldSha } },
          { name: "v1.10.0", commit: { sha: targetSha } },
        ],
        releases,
        "external-move",
      ),
    ).toThrow();
  });

  it("fails closed when another run wins an absent-tag creation race", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    const targetSha = "2".repeat(40);
    const releases = [
      {
        tag_name: "v1.10.0",
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      },
    ];

    expect(() =>
      runReleaseUpdate(
        workflow,
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        releases,
        "create-race",
      ),
    ).toThrow();
  });

  it("fails closed when moving-tag monotonicity cannot be proven", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    const script = releaseDecisionScript(workflow);
    const targetSha = "2".repeat(40);

    expect(() =>
      decideRelease(script, "v2.10.12", targetSha, [
        { name: "v2", commit: { sha: "f".repeat(40) } },
        { name: "v2.10.12", commit: { sha: targetSha } },
      ]),
    ).toThrow(/known immutable stable release/);
    expect(() =>
      decideRelease(script, "v2.10.12", targetSha, [
        { name: "v2.10.12", commit: { sha: "e".repeat(40) } },
      ]),
    ).toThrow(/does not match its immutable tag/);
  });

  it("ignores tags without a successfully published stable release", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    const script = releaseDecisionScript(workflow);
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

  it("requires the triggering release and every eligible release to match a tag", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    const script = releaseDecisionScript(workflow);
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
