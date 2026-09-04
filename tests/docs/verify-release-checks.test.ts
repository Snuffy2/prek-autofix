import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const REPOSITORY = "owner/repository";
const REF = "release-validation/v1.2.3-123-1";
const SHA = "a".repeat(40);
const RUN_ID = 123;

type Api = (
  arguments_: string[],
  expectedStatus?: number,
) => Record<string, unknown>;

interface WaitForWorkflowOptions {
  readonly api: Api;
  readonly deadline: number;
  readonly expectedRunId: number;
  readonly now: () => number;
  readonly ref: string;
  readonly repository: string;
  readonly requiredChecks: ReadonlySet<string>;
  readonly sha: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly workflow: string;
}

interface ReleaseVerifier {
  readonly GitHubCommandError: typeof Error;
  readonly dispatchWorkflow: (
    repository: string,
    workflow: string,
    ref: string,
    sha: string,
    api: Api,
  ) => number;
  readonly publishVerifiedStatus: (
    repository: string,
    sha: string,
    check: string,
    runId: number,
    api: Api,
  ) => void;
  readonly verifyJobs: (
    repository: string,
    runId: number,
    requiredChecks: ReadonlySet<string>,
    api: Api,
  ) => void;
  readonly waitForWorkflow: (
    options: WaitForWorkflowOptions,
  ) => Promise<number>;
}

let verifier: ReleaseVerifier;

beforeAll(async () => {
  verifier = (await import(
    pathToFileURL(resolve(".github/scripts/verify-release-checks.mjs")).href
  )) as ReleaseVerifier;
});

function completedRun(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    check_suite_id: 42,
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: REF,
    head_sha: SHA,
    id: RUN_ID,
    status: "completed",
    workflow_id: 7,
    ...overrides,
  };
}

function verifiedApi(run = completedRun()): Api {
  return (arguments_) => {
    const endpoint = arguments_.at(-1);
    if (endpoint === "repos/owner/repository/actions/workflows/ci.yml") {
      return { id: 7 };
    }
    if (endpoint === "repos/owner/repository/actions/runs/123") return run;
    if (endpoint === "repos/owner/repository/check-suites/42") {
      return { app: { slug: "github-actions" }, head_sha: SHA };
    }
    if (
      endpoint === "repos/owner/repository/actions/runs/123/jobs?per_page=100"
    ) {
      return {
        jobs: [
          { conclusion: "success", name: "Node CI" },
          { conclusion: "success", name: "review" },
        ],
        total_count: 2,
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
}

describe("release check verification", () => {
  it("dispatches the candidate ref and requires a numeric workflow run ID", () => {
    const calls: Array<{ arguments_: string[]; expectedStatus?: number }> = [];
    const api: Api = (arguments_, expectedStatus) => {
      calls.push({ arguments_, expectedStatus });
      return { workflow_run_id: RUN_ID };
    };

    expect(verifier.dispatchWorkflow(REPOSITORY, "ci.yml", REF, SHA, api)).toBe(
      RUN_ID,
    );
    expect(calls).toEqual([
      {
        arguments_: expect.arrayContaining([
          "repos/owner/repository/actions/workflows/ci.yml/dispatches",
          `ref=${REF}`,
          `inputs[expected_sha]=${SHA}`,
        ]),
        expectedStatus: 200,
      },
    ]);
    expect(() =>
      verifier.dispatchWorkflow(REPOSITORY, "ci.yml", REF, SHA, () => ({})),
    ).toThrow("valid workflow_run_id");
  });

  it("accepts only the completed successful candidate run and its required checks", async () => {
    await expect(
      verifier.waitForWorkflow({
        deadline: 1,
        expectedRunId: RUN_ID,
        ref: REF,
        repository: REPOSITORY,
        requiredChecks: new Set(["Node CI", "review"]),
        sha: SHA,
        workflow: "ci.yml",
        api: verifiedApi(),
        now: () => 0,
      }),
    ).resolves.toBe(RUN_ID);
  });

  it("rejects a completed run whose identity or check suite differs from the candidate", async () => {
    await expect(
      verifier.waitForWorkflow({
        deadline: 1,
        expectedRunId: RUN_ID,
        ref: REF,
        repository: REPOSITORY,
        requiredChecks: new Set(["Node CI"]),
        sha: SHA,
        workflow: "ci.yml",
        api: verifiedApi(completedRun({ head_sha: "b".repeat(40) })),
        now: () => 0,
      }),
    ).rejects.toThrow("does not match the dispatched identity");
  });

  it("fails closed for incomplete required jobs and workflow timeouts", async () => {
    expect(() =>
      verifier.verifyJobs(REPOSITORY, RUN_ID, new Set(["Node CI"]), () => ({
        jobs: [{ conclusion: "failure", name: "Node CI" }],
        total_count: 1,
      })),
    ).toThrow("unsuccessful");

    let time = 0;
    await expect(
      verifier.waitForWorkflow({
        deadline: 1,
        expectedRunId: RUN_ID,
        ref: REF,
        repository: REPOSITORY,
        requiredChecks: new Set(["Node CI"]),
        sha: SHA,
        workflow: "ci.yml",
        api: verifiedApi(completedRun({ status: "in_progress" })),
        now: () => time,
        sleep: async (milliseconds: number) => {
          time += milliseconds;
        },
      }),
    ).rejects.toThrow("Timed out waiting for workflow");
  });

  it("publishes a status only when GitHub confirms the requested context", () => {
    const calls: string[][] = [];
    const api: Api = (arguments_) => {
      calls.push(arguments_);
      return { context: "Node CI", state: "success" };
    };

    expect(() =>
      verifier.publishVerifiedStatus(REPOSITORY, SHA, "Node CI", RUN_ID, api),
    ).not.toThrow();
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        `repos/owner/repository/statuses/${SHA}`,
        "context=Node CI",
        "state=success",
      ]),
    );
    expect(() =>
      verifier.publishVerifiedStatus(
        REPOSITORY,
        SHA,
        "Node CI",
        RUN_ID,
        () => ({}),
      ),
    ).toThrow(verifier.GitHubCommandError);
  });
});
