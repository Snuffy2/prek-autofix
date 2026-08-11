import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  it.each([
    ["Stage 1", "prek-autofix-stage-1", "examples/prek-autofix-review.yml"],
    ["Stage 2", "prek-autofix-stage-2", "examples/prek-autofix-fix.yml"],
  ])(
    "keeps README %s synchronized with its example",
    (_stage, marker, path) => {
      expect(readReadmeSnippet(marker)).toBe(read(path));
    },
  );
});
