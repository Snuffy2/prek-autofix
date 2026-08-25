import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

function workflow(filename: string): ReturnType<typeof parse> {
  return parse(
    readFileSync(resolve(root, ".github/workflows", filename), "utf8"),
  );
}

interface WorkflowStep {
  readonly id?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

describe("repository maintenance workflows", () => {
  it("reviews the exact pull request head with the local review action", () => {
    const review = workflow("prek-autofix-review.yml");
    const reviewJob = review.jobs.review;
    const checkout = reviewJob.steps.find(
      (step: WorkflowStep) =>
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.repository ===
          "${{ github.event.pull_request.head.repo.full_name }}" &&
        step.with?.ref === "${{ github.event.pull_request.head.sha }}",
    );
    const reviewStep = reviewJob.steps.find(
      (step: WorkflowStep) => step.id === "review",
    );

    expect(review.name).toBe("prek-autofix");
    expect(review.permissions).toEqual({ contents: "read" });
    expect(checkout).toMatchObject({
      with: {
        "repository": "${{ github.event.pull_request.head.repo.full_name }}",
        "ref": "${{ github.event.pull_request.head.sha }}",
        "persist-credentials": false,
      },
    });
    expect(reviewStep).toMatchObject({
      id: "review",
      uses: "./review",
    });
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
    const revokeStep = revoke.steps.find((step: { run?: string }) =>
      step.run?.includes("gh pr merge --disable-auto"),
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
      /always\(\).*verify-dependabot-metadata\.result == 'failure'.*verify-changed-files\.result == 'failure'/s,
    );
    expect(revoke.permissions).toEqual({
      "contents": "write",
      "pull-requests": "write",
    });
    expect(revokeStep).toBeDefined();
  });
});
