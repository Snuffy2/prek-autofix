import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

function workflow(filename: string): ReturnType<typeof parse> {
  return parse(
    readFileSync(resolve(root, ".github/workflows", filename), "utf8"),
  );
}

interface WorkflowStep {
  readonly env?: Record<string, string>;
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

function requiredStep(
  steps: WorkflowStep[],
  predicate: (step: WorkflowStep) => boolean,
): WorkflowStep {
  const step = steps.find(predicate);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

function dependabotScopeStatus(script: string, changedFiles: string[]): number {
  const directory = mkdtempSync(join(tmpdir(), "prek-autofix-dependabot-"));
  writeFileSync(
    join(directory, "gh"),
    "#!/bin/sh\nprintf '%s' \"${CHANGED_FILES}\"\n",
    { mode: 0o755 },
  );
  try {
    return (
      spawnSync("/bin/bash", ["-c", script], {
        env: {
          ...process.env,
          CHANGED_FILES: changedFiles.join("\n"),
          GH_TOKEN: "test-token",
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          PR_NUMBER: "50",
          REPOSITORY: "Snuffy2/prek-autofix",
        },
      }).status ?? 1
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("repository maintenance workflows", () => {
  it("reviews the exact pull request head and verifies a dispatched candidate", () => {
    const review = workflow("prek-autofix-review.yml");
    const reviewJob = review.jobs.review;
    const checkout = reviewJob.steps.find((step: WorkflowStep) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const reviewStep = reviewJob.steps.find(
      (step: WorkflowStep) =>
        step.uses === "./review" &&
        step.if === "github.event_name == 'pull_request'",
    );
    const candidateStep = reviewJob.steps.find(
      (step: WorkflowStep) =>
        step.uses?.startsWith("j178/prek-action@") &&
        step.if === "github.event_name == 'workflow_dispatch'",
    );
    const cleanCandidate = reviewJob.steps.find(
      (step: WorkflowStep) =>
        step.if === "github.event_name == 'workflow_dispatch'" &&
        step.run?.includes("git status --porcelain") === true,
    );

    expect(review.name).toBe("prek-autofix");
    expect(review.permissions).toEqual({ contents: "read" });
    expect(checkout).toMatchObject({
      with: {
        "repository": expect.stringContaining(
          "github.event.pull_request.head.repo.full_name",
        ),
        "ref": expect.stringContaining("github.event.pull_request.head.sha"),
        "persist-credentials": false,
      },
    });
    expect(checkout?.with?.ref).toContain("inputs.expected_sha");
    expect(reviewStep).toMatchObject({
      uses: "./review",
    });
    expect(candidateStep).toBeDefined();
    expect(cleanCandidate).toBeDefined();
    expect(JSON.stringify(reviewJob)).not.toContain("PREK_AUTOFIX_TOKEN");
  });

  it("loads the local fix action only from trusted main", () => {
    const fixWorkflow = workflow("prek-autofix-fix.yml");
    const steps = fixWorkflow.jobs.fix.steps;
    const checkout = steps.find(
      (step: WorkflowStep) =>
        step.uses?.startsWith("actions/checkout@") && step.with?.ref === "main",
    );
    const fix = steps.find((step: WorkflowStep) => step.uses === "./fix");

    expect(fixWorkflow.on.workflow_run).toEqual({
      workflows: ["prek-autofix"],
      types: ["completed"],
    });
    expect(fixWorkflow.jobs.fix.if).toBe(
      "github.event.workflow_run.event == 'pull_request'",
    );
    expect(fixWorkflow.permissions).toEqual({
      "actions": "read",
      "contents": "write",
      "pull-requests": "write",
      "statuses": "write",
    });
    expect(checkout).toMatchObject({
      with: {
        "ref": "main",
        "persist-credentials": false,
      },
    });
    expect(fix).toMatchObject({
      uses: "./fix",
      with: {
        "autofix-token": "${{ secrets.PREK_AUTOFIX_TOKEN }}",
        "source-workflow": "prek-autofix",
      },
    });
    expect(JSON.stringify(checkout)).not.toContain("PREK_AUTOFIX_TOKEN");
  });

  it("revokes Dependabot auto-merge when either eligibility check fails", () => {
    const dependabotWorkflow = workflow("dependabot-auto-merge.yml");
    const metadata = dependabotWorkflow.jobs["verify-dependabot-metadata"];
    const changedFiles = dependabotWorkflow.jobs["verify-changed-files"];
    const enable = dependabotWorkflow.jobs["enable-auto-merge"];
    const revoke = dependabotWorkflow.jobs["disable-auto-merge"];
    const metadataAction = metadata.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("dependabot/fetch-metadata@"),
    );
    const metadataCheckout = metadata.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const changedFilesCheckout = changedFiles.steps.find(
      (step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"),
    );
    const revokeStep = requiredStep(
      revoke.steps,
      (step) => step.run?.includes("gh pr merge --disable-auto") ?? false,
    );

    expect(metadataAction).toBeDefined();
    expect(metadata.permissions).toEqual({
      "contents": "read",
      "pull-requests": "read",
    });
    expect(metadataCheckout).toBeUndefined();
    expect(changedFiles.permissions).toEqual({
      "contents": "read",
      "pull-requests": "read",
    });
    expect(changedFilesCheckout).toBeUndefined();
    expect(changedFiles.needs).toBeUndefined();
    expect(changedFiles.steps[0].env).not.toHaveProperty("PACKAGE_ECOSYSTEM");
    expect(enable.needs).toEqual([
      "verify-dependabot-metadata",
      "verify-changed-files",
    ]);
    expect(revoke.needs).toEqual([
      "verify-dependabot-metadata",
      "verify-changed-files",
    ]);
    expect(revoke.if).toMatch(
      /failure\(\).*verify-dependabot-metadata\.result == 'failure'.*verify-changed-files\.result == 'failure'/s,
    );
    expect(revoke.if).toContain("!cancelled()");
    expect(revoke.if).not.toContain("always()");
    expect(revoke.permissions).toEqual({
      "contents": "write",
      "pull-requests": "write",
    });
    expect(revokeStep.run).toContain("gh pr merge --disable-auto");
  });

  it("accepts generated bundles only as part of an npm lockfile update", () => {
    const dependabotWorkflow = workflow("dependabot-auto-merge.yml");
    const changedFilesStep = requiredStep(
      dependabotWorkflow.jobs["verify-changed-files"].steps,
      (step) => step.run !== undefined,
    );
    const script = changedFilesStep.run as string;

    expect(
      dependabotScopeStatus(script, [
        "package.json",
        "package-lock.json",
        "dist/apply/index.js",
        "dist/collect/index.js",
      ]),
    ).toBe(0);
    expect(dependabotScopeStatus(script, [".github/workflows/ci.yml"])).toBe(0);
    expect(dependabotScopeStatus(script, ["dist/apply/index.js"])).not.toBe(0);
    expect(
      dependabotScopeStatus(script, [
        "package-lock.json",
        "packages/apply/src/index.ts",
      ]),
    ).not.toBe(0);
  });
});
