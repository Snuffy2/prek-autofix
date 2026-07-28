import { describe, expect, it } from "vitest";
import { workflowArtifactUrl } from "../../packages/apply/src/urls";

describe("workflowArtifactUrl", () => {
  it("identifies the selected artifact in the recovery URL", () => {
    expect(
      workflowArtifactUrl(
        "https://github.example",
        "base/repo",
        123,
        456,
      ),
    ).toBe(
      "https://github.example/base/repo/actions/runs/123/artifacts/456",
    );
  });
});
