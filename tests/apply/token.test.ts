import { describe, expect, it } from "vitest";
import { selectMutationToken } from "../../packages/apply/src/token";

describe("selectMutationToken", () => {
  it.each([
    {
      name: "configured token",
      configured: "configured",
      builtIn: "built-in",
      expected: { token: "configured", usedGithubTokenFallback: false },
    },
    {
      name: "empty configured token",
      configured: "",
      builtIn: "built-in",
      expected: { token: "built-in", usedGithubTokenFallback: true },
    },
    {
      name: "matching configured and built-in tokens",
      configured: "built-in",
      builtIn: "built-in",
      expected: { token: "built-in", usedGithubTokenFallback: false },
    },
  ])("selects the $name correctly", ({ configured, builtIn, expected }) => {
    expect(selectMutationToken(configured, builtIn)).toEqual(expected);
  });
});
