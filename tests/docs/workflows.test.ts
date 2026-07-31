import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function readReadmeSnippet(marker: string): string {
  const readme = read("README.md");
  const expression = new RegExp(
    "<!-- BEGIN " +
      marker +
      " -->\\n```yaml\\n([\\s\\S]*?)\\n```\\n<!-- END " +
      marker +
      " -->",
  );
  const match = readme.match(expression);

  expect(match, `README is missing the ${marker} snippet`).not.toBeNull();
  return `${match?.[1]}\n`;
}

describe("public workflow documentation", () => {
  const reviewPath = "examples/prek-autofix-review.yml";
  const fixPath = "examples/prek-autofix-fix.yml";

  it("keeps README Stage 1 synchronized with the canonical workflow", () => {
    expect(readReadmeSnippet("prek-autofix-stage-1")).toBe(read(reviewPath));
  });

  it("keeps README Stage 2 synchronized with the canonical workflow", () => {
    expect(readReadmeSnippet("prek-autofix-stage-2")).toBe(read(fixPath));
  });

  it("keeps the review workflow read-only and on the PR head", () => {
    const workflow = parse(read(reviewPath));
    const checkout = workflow.jobs.review.steps[0];

    expect(workflow.name).toBe("prek-autofix");
    expect(workflow.on.pull_request.types).toContain("synchronize");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      "group": "prek-autofix-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
    expect(checkout.uses).toMatch(/^actions\/checkout@/);
    expect(checkout.with).toMatchObject({
      "repository": "${{ github.event.pull_request.head.repo.full_name }}",
      "ref": "${{ github.event.pull_request.head.sha }}",
      "persist-credentials": false,
    });
    expect(workflow.jobs.review.steps[1]).toMatchObject({
      id: "review",
      uses: "Snuffy2/prek-autofix/review@v1",
    });
    expect(Object.keys(workflow.jobs)).toEqual(["review"]);
    expect(workflow.jobs.review["timeout-minutes"]).toBe(15);
  });

  it("keeps the fix workflow privileged without a checkout", () => {
    const workflow = parse(read(fixPath));
    const fix = workflow.jobs.fix;

    expect(workflow.on.workflow_run).toEqual({
      workflows: ["prek-autofix"],
      types: ["completed"],
    });
    expect(workflow.permissions).toEqual({
      "actions": "read",
      "contents": "read",
      "pull-requests": "write",
    });
    expect(workflow.concurrency).toEqual({
      "group":
        "prek-autofix-fix-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}",
      "cancel-in-progress": false,
    });
    expect(fix.if).toBe("github.event.workflow_run.event == 'pull_request'");
    expect(fix.steps).toEqual([
      {
        uses: "Snuffy2/prek-autofix/fix@v1",
        env: {
          GITHUB_TOKEN: "${{ github.token }}",
        },
        with: {
          "autofix-token": "${{ secrets.PREK_AUTOFIX_TOKEN }}",
          "source-workflow": "prek-autofix",
        },
      },
    ]);
    expect(JSON.stringify(fix)).not.toContain("actions/checkout");
  });
});
