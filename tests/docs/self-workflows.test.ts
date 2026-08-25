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

describe("repository maintenance workflows", () => {
  it("uses the v2 prek autoupdate action with built-in PAT auto-merge", () => {
    const autoupdate = workflow("prek_autoupdate.yml");
    const job = autoupdate.jobs["prek-autoupdate"];
    const update = job.steps.find(
      (step: { uses?: string }) => step.uses === "Snuffy2/prek-autoupdate@v2",
    );

    expect(job.permissions).toEqual({ contents: "read" });
    expect(update).toMatchObject({
      uses: "Snuffy2/prek-autoupdate@v2",
      with: {
        "token": "${{ secrets.PREK_AUTOUPDATE_TOKEN }}",
        "auto-merge": true,
        "update-day": "0",
      },
    });
  });

  it("reviews the exact pull request head with the local review action", () => {
    const review = workflow("prek-autofix-review.yml");
    const reviewJob = review.jobs.review;
    const checkout = reviewJob.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const install = reviewJob.steps.find(
      (step: { run?: string }) => step.run === "npm ci --ignore-scripts",
    );
    const reviewStep = reviewJob.steps.find(
      (step: { id?: string }) => step.id === "review",
    );

    expect(review.name).toBe("prek-autofix");
    expect(review.permissions).toEqual({ contents: "read" });
    expect(checkout).toMatchObject({
      uses: expect.stringMatching(/^actions\/checkout@v\d+$/),
      with: {
        "repository": "${{ github.event.pull_request.head.repo.full_name }}",
        "ref": "${{ github.event.pull_request.head.sha }}",
        "persist-credentials": false,
      },
    });
    expect(install).toMatchObject({
      run: "npm ci --ignore-scripts",
    });
    expect(reviewStep).toMatchObject({
      id: "review",
      uses: "./review",
    });
    expect(reviewJob["timeout-minutes"]).toBe(15);
    expect(JSON.stringify(reviewJob)).not.toContain("PREK_AUTOFIX_TOKEN");
  });

  it("loads the local fix action only from trusted main", () => {
    const fixWorkflow = workflow("prek-autofix-fix.yml");
    const steps = fixWorkflow.jobs.fix.steps;
    const checkout = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const fix = steps.find((step: { uses?: string }) => step.uses === "./fix");

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
      uses: expect.stringMatching(/^actions\/checkout@v\d+$/),
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
    expect(JSON.stringify(steps)).not.toContain("GITHUB_TOKEN");
  });
});
