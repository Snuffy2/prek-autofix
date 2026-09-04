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
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
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
        step.uses === "j178/prek-action@v2" &&
        step.if === "github.event_name == 'workflow_dispatch'",
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
    expect(reviewStep).toMatchObject({
      uses: "./review",
    });
    expect(candidateStep).toBeDefined();
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
});
