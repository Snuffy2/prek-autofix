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
    const signalJob = review.jobs.signal;
    const checkout = review.jobs.review.steps[0];

    expect(review.name).toBe("prek-autofix");
    expect(review.permissions).toEqual({ contents: "read" });
    expect(reviewJob.outputs).toEqual({
      changed: "${{ steps.review.outputs.changed }}",
    });
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
    expect(signalJob.needs).toBe("review");
    expect(signalJob.if).toBe("needs.review.outputs.changed == 'true'");
    expect(signalJob.steps).toEqual([
      {
        name: "Report pending prek fixes",
        run: "exit 1",
      },
    ]);
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
      "github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'failure'",
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
    expect(JSON.stringify(steps).match(/PREK_AUTOFIX_TOKEN/g)).toHaveLength(1);
  });

  it("uses the released autoupdate action for repository maintenance", () => {
    const autoupdate = workflow("prek_autoupdate_self.yml");
    const steps = autoupdate.jobs["prek-autoupdate"].steps;

    expect(autoupdate.on).toMatchObject({
      schedule: [{ cron: "0 4 * * *" }],
      push: { branches: ["main"] },
      workflow_dispatch: null,
    });
    expect(autoupdate.jobs["prek-autoupdate"].permissions).toEqual({
      "contents": "write",
      "pull-requests": "write",
    });
    expect(steps[0]).toMatchObject({
      uses: expect.stringMatching(/^actions\/checkout@/),
      with: { "persist-credentials": false },
    });
    expect(steps[1]).toMatchObject({
      uses: "Snuffy2/prek-autoupdate@v2",
      with: { "update-day": "0" },
    });
  });
});
