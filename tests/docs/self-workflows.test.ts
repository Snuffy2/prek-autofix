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
  it("keeps title validation read-only without executing pull request code", () => {
    const titleLint = workflow("semantic-pull-request.yml");
    expect(titleLint.on.pull_request_target.types).toContain("edited");
    expect(titleLint.jobs.validate.permissions).toEqual({
      "pull-requests": "read",
    });
    for (const step of titleLint.jobs.validate.steps as WorkflowStep[]) {
      expect(step.run).toBeUndefined();
      expect(step.uses?.startsWith("actions/checkout@")).not.toBe(true);
    }
  });

  it("gives hook updates a dependency title accepted by the title lint", () => {
    const titleLint = workflow("semantic-pull-request.yml");
    const validator = titleLint.jobs.validate.steps.find((step: WorkflowStep) =>
      step.uses?.startsWith("amannn/action-semantic-pull-request@"),
    );
    const update = workflow("prek_autoupdate.yml").jobs[
      "prek-autoupdate"
    ].steps.find((step: WorkflowStep) =>
      step.uses?.startsWith("Snuffy2/prek-autoupdate@"),
    );
    const title = update.with["pr-title"] as string;
    expect(title).toMatch(/^deps: .+/u);
    expect(update.with["commit-message"]).toBe(title);
    const allowedTypes = (validator.with.types as string).trim().split(/\s+/u);
    expect(allowedTypes).toContain(title.split(":")[0]);
  });

  it("reviews the exact pull request head without write credentials", () => {
    const review = workflow("prek-autofix-review.yml");
    const reviewJob = review.jobs.review;
    const checkout = reviewJob.steps.find((step: WorkflowStep) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const reviewStep = reviewJob.steps.find(
      (step: WorkflowStep) => step.uses === "./review",
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
