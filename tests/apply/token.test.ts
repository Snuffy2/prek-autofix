import { describe, expect, it } from "vitest";
import { selectMutationToken } from "../../packages/apply/src/token";

describe("selectMutationToken", () => {
  it("always prefers a configured autofix token", () => {
    expect(selectMutationToken("configured", "built-in")).toEqual({
      token: "configured",
      isBuiltIn: false,
    });
  });

  it("falls back to the built-in token when the required input is empty", () => {
    expect(selectMutationToken("", "built-in")).toEqual({
      token: "built-in",
      isBuiltIn: true,
    });
  });

  it("recognizes an explicitly supplied built-in token", () => {
    expect(selectMutationToken("built-in", "built-in")).toEqual({
      token: "built-in",
      isBuiltIn: true,
    });
  });
});
