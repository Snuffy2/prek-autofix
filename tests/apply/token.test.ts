import { describe, expect, it } from "vitest";
import { selectMutationToken } from "../../packages/apply/src/token";

describe("selectMutationToken", () => {
  it("always prefers a configured autofix token", () => {
    expect(selectMutationToken("configured", "built-in")).toEqual({
      token: "configured",
      usedGithubTokenFallback: false,
    });
  });

  it("falls back to the built-in token when the required input is empty", () => {
    expect(selectMutationToken("", "built-in")).toEqual({
      token: "built-in",
      usedGithubTokenFallback: true,
    });
  });

  it("treats an explicitly configured token as configured even when values match", () => {
    expect(selectMutationToken("built-in", "built-in")).toEqual({
      token: "built-in",
      usedGithubTokenFallback: false,
    });
  });
});
