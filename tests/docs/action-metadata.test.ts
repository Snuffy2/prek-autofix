import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

async function metadata(path: string): Promise<Record<string, any>> {
  return parse(await readFile(resolve(path), "utf8"));
}

describe("action metadata", () => {
  it("keeps the collection action unprivileged and pinned", async () => {
    const action = await metadata("collect/action.yml");
    expect(Object.keys(action.inputs)).toEqual([
      "prek-version",
      "extra-args",
      "working-directory",
      "cache",
      "max-passes",
    ]);
    expect(action.inputs["max-passes"].default).toBe("3");
    expect(action.outputs).toHaveProperty("changed");
    expect(action.outputs).toHaveProperty("artifact-name");
    expect(action.outputs).toHaveProperty("prek-version");
    expect(action.runs.using).toBe("composite");

    const serialized = JSON.stringify(action);
    expect(serialized).toContain(
      "actions/setup-node@395ad3262231945c25e8478fd5baf05154b1d79f",
    );
    expect(serialized).toContain(
      "j178/prek-action@5337cb91e0fa35a7ff31b9ca345126d8bbbcdf16",
    );
    expect(serialized).toContain("$GITHUB_ACTION_PATH/../dist/collect/index.js");
    expect(serialized).not.toMatch(/autofix-token|PREK_AUTOFIX_TOKEN|checkout/i);
  });

  it("uses an isolated Node 24 privileged entry point", async () => {
    const action = await metadata("apply/action.yml");
    expect(action.runs).toEqual({
      using: "node24",
      main: "../dist/apply/index.js",
    });
    expect(action.inputs["autofix-token"].required).toBe(true);
    expect(action.inputs["commit-message"].default).toBe(
      "[prek-autofix] apply automatic fixes",
    );
    expect(action.inputs["source-workflow"].default).toBe("prek-autofix");
    expect(action.inputs["max-files"].default).toBe("100");
    expect(action.inputs["max-bytes"].default).toBe("10485760");

    const source = await readFile("packages/apply/src/index.ts", "utf8");
    expect(source).not.toMatch(/child_process|spawn\(|exec\(|checkout/);
    expect(source).not.toMatch(/["']git["']/);
  });

  it("ships both bundled entry points", async () => {
    const collectBundle = await readFile("dist/collect/index.js");
    const applyBundle = await readFile("dist/apply/index.js");
    expect(collectBundle.byteLength).toBeGreaterThan(0);
    expect(applyBundle.byteLength).toBeGreaterThan(0);
  });

  it("isolates release verification from repository write credentials", async () => {
    const workflow = await metadata(".github/workflows/release.yml");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.verify.steps[0].with["persist-credentials"]).toBe(false);
    expect(workflow.jobs["update-major"].permissions).toEqual({
      contents: "write",
    });
    expect(JSON.stringify(workflow.jobs["update-major"])).not.toMatch(
      /npm ci|npm test|checkout|packages\//,
    );
  });
});
