import * as core from "@actions/core";
import * as github from "@actions/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyArtifact: vi.fn(),
  downloadArtifact: vi.fn(),
  getArtifact: vi.fn(),
  readFile: vi.fn(),
  resolveSourcePullRequest: vi.fn(),
  verifySourceJobs: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setSecret: vi.fn(),
  setFailed: vi.fn(),
}));
vi.mock("@actions/github", () => ({
  context: {
    eventName: "workflow_run",
    payload: { workflow_run: { id: 7, run_attempt: 3 } },
    repo: { owner: "base", repo: "repo" },
    serverUrl: "https://github.example",
    runId: 99,
  },
  getOctokit: vi.fn(),
}));
vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    getArtifact = mocks.getArtifact;
    downloadArtifact = mocks.downloadArtifact;
  },
}));
vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({ size: 100 }),
  readFile: mocks.readFile,
}));
vi.mock("../../packages/apply/src/apply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/apply/src/apply")>()),
  applyArtifact: mocks.applyArtifact,
  resolveSourcePullRequest: mocks.resolveSourcePullRequest,
}));
vi.mock("../../packages/apply/src/source-jobs", () => ({
  IneligibleSourceJobsError: class extends Error {},
  verifySourceJobs: mocks.verifySourceJobs,
}));

const headSha = "a".repeat(40);
const artifact = {
  schemaVersion: 1,
  source: {
    runId: 7,
    runAttempt: 3,
    repository: "base/repo",
    workflow: "prek-autofix",
    event: "pull_request",
    pullRequestNumber: 4,
    headSha,
  },
  operations: [
    { path: "fixed.txt", operation: "add", mode: "100644", content: "eA==" },
  ],
};

function client(): {
  rest: {
    repos: { createCommitStatus: ReturnType<typeof vi.fn> };
    issues: {
      createComment: ReturnType<typeof vi.fn>;
      listComments: ReturnType<typeof vi.fn>;
    };
  };
  paginate: ReturnType<typeof vi.fn>;
} {
  return {
    rest: {
      repos: { createCommitStatus: vi.fn().mockResolvedValue({}) },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
        listComments: vi.fn(),
      },
    },
    paginate: vi.fn().mockResolvedValue([]),
  };
}

describe("status reporting credentials at the action entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getArtifact.mockResolvedValue({ artifact: { id: 42 } });
    mocks.downloadArtifact.mockResolvedValue({ downloadPath: "/artifact" });
    mocks.readFile.mockResolvedValue(JSON.stringify(artifact));
    mocks.verifySourceJobs.mockResolvedValue(undefined);
    mocks.applyArtifact.mockResolvedValue(undefined);
    mocks.resolveSourcePullRequest.mockResolvedValue({
      run: { headSha },
      pullRequest: { number: 4 },
    });
  });

  it.each([
    { autofixToken: "pat-sentinel", failure: "none" },
    { autofixToken: "", failure: "none" },
    { autofixToken: "pat-sentinel", failure: "download" },
    { autofixToken: "", failure: "download" },
    { autofixToken: "pat-sentinel", failure: "validation" },
    { autofixToken: "pat-sentinel", failure: "mutation" },
    { autofixToken: "rejected-pat-sentinel", failure: "credentials" },
  ])(
    "uses the selected credential ($autofixToken, $failure)",
    async ({ autofixToken, failure }) => {
      const readClient = client();
      const patClient = client();
      vi.mocked(core.getInput).mockImplementation((name) => {
        if (name === "github-token") return "read-token-sentinel";
        if (name === "autofix-token") return autofixToken;
        return "";
      });
      vi.mocked(github.getOctokit).mockImplementation(
        (token) =>
          (token === "read-token-sentinel" ? readClient : patClient) as never,
      );
      if (failure === "download")
        mocks.downloadArtifact.mockRejectedValue(new Error("download failed"));
      if (failure === "validation") mocks.readFile.mockResolvedValue("{}");
      if (failure === "mutation" || failure === "credentials")
        mocks.applyArtifact.mockRejectedValue(new Error("mutation rejected"));
      if (failure === "credentials")
        patClient.rest.repos.createCommitStatus.mockRejectedValue(
          new Error("unauthorized"),
        );

      await import("../../packages/apply/src/index.js");
      await vi.waitFor(() => {
        if (failure === "none") {
          expect(
            (autofixToken ? patClient : readClient).rest.repos
              .createCommitStatus,
          ).toHaveBeenCalledWith(expect.objectContaining({ state: "success" }));
        } else {
          expect(core.setFailed).toHaveBeenCalledOnce();
        }
      });
      const statusClient = autofixToken ? patClient : readClient;
      expect(core.setSecret).toHaveBeenCalledWith(
        autofixToken || "read-token-sentinel",
      );
      expect(patClient.rest.issues.createComment).not.toHaveBeenCalled();
      if (failure !== "none")
        expect(readClient.rest.issues.createComment).toHaveBeenCalledOnce();
      expect(
        statusClient.rest.repos.createCommitStatus.mock.calls.map(
          ([request]) => request.state,
        ),
      ).toEqual(["pending", failure === "none" ? "success" : "failure"]);
      for (const [request] of statusClient.rest.repos.createCommitStatus.mock
        .calls) {
        expect(request).toMatchObject({
          owner: "base",
          repo: "repo",
          sha: headSha,
          context: "prek-autofix/fix",
          target_url: "https://github.example/base/repo/actions/runs/99",
        });
      }
      expect(
        (autofixToken ? readClient : patClient).rest.repos.createCommitStatus,
      ).not.toHaveBeenCalled();
      expect(mocks.verifySourceJobs).toHaveBeenCalledWith(
        readClient,
        "base",
        "repo",
        7,
        3,
      );
      expect(mocks.downloadArtifact).toHaveBeenCalledWith(42, {
        findBy: {
          token: "read-token-sentinel",
          workflowRunId: 7,
          repositoryOwner: "base",
          repositoryName: "repo",
        },
      });
      if (["download", "validation"].includes(failure))
        expect(mocks.applyArtifact).not.toHaveBeenCalled();
      if (failure === "credentials")
        expect(core.warning).toHaveBeenCalledWith(
          "prek-autofix could not publish its pull request status",
        );
    },
  );
});
