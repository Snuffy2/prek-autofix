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
  it("starts the collection bundle", () => {
    const output = runBundle("dist/collect/index.js");

    expect(output).toContain(
      "context.repo requires a GITHUB_REPOSITORY environment variable",
    );
    expect(output).not.toContain("ERR_INVALID_ARG_VALUE");
  });

  it("starts the application bundle", () => {
    const output = runBundle("dist/apply/index.js");

    expect(output).toContain("apply action may only run for workflow_run");
    expect(output).not.toContain("ERR_INVALID_ARG_VALUE");
  });
});
