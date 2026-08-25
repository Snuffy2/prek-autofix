import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

function runBundle(path: string): string {
  const result = spawnSync(process.execPath, [resolve(root, path)], {
    cwd: root,
    encoding: "utf8",
    env: {},
  });

  expect(result.status).toBe(1);
  return `${result.stdout}${result.stderr}`;
}

describe("bundled action startup", () => {
  it.each([
    {
      name: "review",
      path: "dist/collect/index.js",
      expected:
        "context.repo requires a GITHUB_REPOSITORY environment variable",
    },
    {
      name: "fix",
      path: "dist/apply/index.js",
      expected: "fix action may only run for workflow_run",
    },
  ])("starts the $name bundle", ({ path, expected }) => {
    const output = runBundle(path);

    expect(output).toContain(expected);
    expect(output).not.toContain("ERR_INVALID_ARG_VALUE");
  });
});
