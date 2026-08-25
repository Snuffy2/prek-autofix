import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

async function metadata(path: string): Promise<Record<string, any>> {
  return parse(await readFile(resolve(path), "utf8"));
}

describe("action metadata", () => {
  it("keeps the primary and nested review actions synchronized", async () => {
    const primaryAction = await metadata("action.yml");
    const reviewAction = await metadata("review/action.yml");

    expect(reviewAction.inputs).toEqual(primaryAction.inputs);
    expect(reviewAction.outputs).toEqual(primaryAction.outputs);
    expect(primaryAction.runs.using).toBe(reviewAction.runs.using);
    expect(primaryAction.runs.steps).toEqual(
      reviewAction.runs.steps.map((step: Record<string, any>) =>
        step.id === "review"
          ? {
              ...step,
              run: 'node "$GITHUB_ACTION_PATH/dist/collect/index.js"',
            }
          : step,
      ),
    );
  });

  it("does not expose the autofix mutation token to the review action", async () => {
    const action = await metadata("review/action.yml");
    expect(action.inputs).not.toHaveProperty("autofix-token");
  });

  it("uploads a persisted artifact before propagating collection failure", async () => {
    const action = await metadata("review/action.yml");
    const review = action.runs.steps.find(
      (step: Record<string, any>) => step.id === "review",
    );
    const upload = action.runs.steps.find(
      (step: Record<string, any>) => step.id === "upload",
    );
    const propagate = action.runs.steps.find(
      (step: Record<string, any>) => step.id === "propagate",
    );

    expect(review["continue-on-error"]).toBe(true);
    expect(upload).toMatchObject({
      id: "upload",
      if: "steps.review.outputs.artifact-name != ''",
      with: {
        "name": "${{ steps.review.outputs.artifact-name }}",
        "path": "${{ steps.review.outputs.artifact-path }}",
        "if-no-files-found": "error",
      },
    });
    expect(propagate).toMatchObject({
      id: "propagate",
      if: "steps.review.outcome == 'failure'",
      shell: "bash",
      run: "exit 1",
    });
    expect(action.runs.steps.indexOf(upload)).toBeLessThan(
      action.runs.steps.indexOf(propagate),
    );
  });

  it("uses an isolated Node 24 privileged entry point", async () => {
    const action = await metadata("fix/action.yml");
    expect(action.runs).toMatchObject({
      using: "node24",
      main: "../dist/apply/index.js",
    });
    expect(action.inputs["github-token"]).toMatchObject({
      required: false,
      default: "${{ github.token }}",
    });
    expect(action.inputs["autofix-token"].required).toBe(true);
  });
});
