import { describe, expect, it } from "vitest";
import { parseExtraArgs } from "../../packages/collect/src/args";

describe("parseExtraArgs", () => {
  it("parses quoted and escaped arguments without a shell", () => {
    expect(parseExtraArgs('--all-files --hook-stage "pre commit" a\\ b')).toEqual(
      ["--all-files", "--hook-stage", "pre commit", "a b"],
    );
  });

  it("rejects incomplete shell syntax", () => {
    expect(() => parseExtraArgs("'unfinished")).toThrow("unterminated");
    expect(() => parseExtraArgs("unfinished\\")).toThrow("unterminated");
  });
});
