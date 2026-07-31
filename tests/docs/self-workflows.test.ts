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
  it("reviews the exact pull request head with the local review action", () => {
    const review = workflow("prek-autofix-review.yml");
    const reviewJob = review.jobs.review;
    const checkout = review.jobs.review.steps[0];

    expect(review.name).toBe("prek-autofix");
    expect(review.permissions).toEqual({ contents: "read" });
    expect(checkout.uses).toMatch(/^actions\/checkout@/);
    expect(checkout.with).toMatchObject({
      "repository": "${{ github.event.pull_request.head.repo.full_name }}",
      "ref": "${{ github.event.pull_request.head.sha }}",
      "persist-credentials": false,
    });
    expect(review.jobs.review.steps[1]).toMatchObject({
      name: "Install locked action dependencies",
      run: "npm ci --ignore-scripts",
    });
    expect(review.jobs.review.steps[2]).toMatchObject({
      id: "review",
      uses: "./review",
    });
    expect(Object.keys(review.jobs)).toEqual(["review"]);
    expect(JSON.stringify(reviewJob)).not.toContain("PREK_AUTOFIX_TOKEN");
  });

  it("loads the local fix action only from trusted main", () => {
    const fixWorkflow = workflow("prek-autofix-fix.yml");
    const steps = fixWorkflow.jobs.fix.steps;

    expect(fixWorkflow.name).toBe("prek-autofix fix");
    expect(fixWorkflow.on.workflow_run).toEqual({
      workflows: ["prek-autofix"],
      types: ["completed"],
    });
    expect(fixWorkflow.jobs.fix.if).toBe(
      "github.event.workflow_run.event == 'pull_request'",
    );
    expect(fixWorkflow.permissions).toEqual({
      "actions": "read",
      "contents": "read",
      "pull-requests": "write",
    });
    expect(steps[0]).toMatchObject({
      uses: expect.stringMatching(/^actions\/checkout@/),
      with: {
        "ref": "main",
        "persist-credentials": false,
      },
    });
    expect(steps[1]).toMatchObject({
      uses: "./fix",
      with: {
        "autofix-token": "${{ secrets.PREK_AUTOFIX_TOKEN }}",
        "source-workflow": "prek-autofix",
      },
    });
    expect(JSON.stringify(steps[0])).not.toContain("PREK_AUTOFIX_TOKEN");
    expect(JSON.stringify(steps)).not.toContain("GITHUB_TOKEN");
    expect(JSON.stringify(steps).match(/PREK_AUTOFIX_TOKEN/g)).toHaveLength(1);
  });
});
