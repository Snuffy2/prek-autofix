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
  it("collects from the exact pull request head with the local action", () => {
    const collect = workflow("prek-autofix.yml");
    const collectJob = collect.jobs.collect;
    const signalJob = collect.jobs.signal;
    const checkout = collect.jobs.collect.steps[0];

    expect(collect.name).toBe("prek-autofix");
    expect(collect.permissions).toEqual({ contents: "read" });
    expect(collectJob.outputs).toEqual({
      changed: "${{ steps.collect.outputs.changed }}",
    });
    expect(checkout.uses).toMatch(/^actions\/checkout@/);
    expect(checkout.with).toMatchObject({
      "repository": "${{ github.event.pull_request.head.repo.full_name }}",
      "ref": "${{ github.event.pull_request.head.sha }}",
      "persist-credentials": false,
    });
    expect(collect.jobs.collect.steps[1]).toMatchObject({
      name: "Install locked action dependencies",
      run: "npm ci --ignore-scripts",
    });
    expect(collect.jobs.collect.steps[2]).toMatchObject({
      id: "collect",
      uses: "./collect",
    });
    expect(signalJob.needs).toBe("collect");
    expect(signalJob.if).toBe("needs.collect.outputs.changed == 'true'");
    expect(signalJob.steps).toEqual([
      {
        name: "Report pending prek fixes",
        run: "exit 1",
      },
    ]);
    expect(JSON.stringify(collectJob)).not.toContain("PREK_AUTOFIX_TOKEN");
  });

  it("loads the local apply action only from trusted main", () => {
    const applyWorkflow = workflow("prek-autofix-apply.yml");
    const steps = applyWorkflow.jobs.apply.steps;

    expect(applyWorkflow.name).toBe("prek-autofix apply");
    expect(applyWorkflow.on.workflow_run).toEqual({
      workflows: ["prek-autofix"],
      types: ["completed"],
    });
    expect(applyWorkflow.jobs.apply.if).toBe(
      "github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'failure'",
    );
    expect(applyWorkflow.permissions).toEqual({
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
      uses: "./apply",
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
