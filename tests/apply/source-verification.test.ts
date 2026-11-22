import { ArtifactNotFoundError } from "@actions/artifact";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getArtifact: vi.fn(),
  downloadArtifact: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("@actions/artifact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/artifact")>()),
  DefaultArtifactClient: class {
    getArtifact = mocks.getArtifact;
    downloadArtifact = mocks.downloadArtifact;
  },
}));
vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  warning: vi.fn(),
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
vi.mock("node:fs/promises", () => ({
  stat: mocks.stat,
  readFile: mocks.readFile,
}));

const sourceSha = "a".repeat(40);
const updatedSha = "b".repeat(40);
const workflowRun = {
  id: 7,
  name: "prek-autofix",
  event: "pull_request",
  head_sha: sourceSha,
  head_branch: "feature",
  head_repository: { full_name: "base/repo" },
};
const pullRequest = {
  number: 4,
  state: "open",
  base: { repo: { full_name: "base/repo" } },
  head: {
    repo: {
      full_name: "base/repo",
      node_id: "R_base",
      owner: { type: "User" },
    },
    ref: "feature",
    sha: sourceSha,
  },
};

function setup() {
  const reviewJobs = vi
    .fn()
    .mockResolvedValue([{ name: "review", conclusion: "success" }]);
  const associatedPullRequests = vi.fn().mockResolvedValue([pullRequest]);
  const getWorkflowRun = vi.fn().mockResolvedValue({ data: workflowRun });
  const listComments = vi.fn().mockResolvedValue([]);
  const createComment = vi.fn();
  const updateComment = vi.fn();
  const deleteComment = vi.fn();
  const createCommitStatus = vi.fn();
  const createBlob = vi.fn().mockResolvedValue({ data: { sha: "fix-blob" } });
  const createTree = vi.fn().mockResolvedValue({ data: { sha: "fix-tree" } });
  const createCommit = vi.fn().mockResolvedValue({ data: { sha: updatedSha } });
  const updateRefs = vi.fn();

  const readClient = {
    rest: {
      actions: { listJobsForWorkflowRunAttempt: reviewJobs, getWorkflowRun },
      repos: { listPullRequestsAssociatedWithCommit: associatedPullRequests },
      git: {
        getCommit: vi
          .fn()
          .mockResolvedValue({ data: { tree: { sha: "base-tree" } } }),
        getTree: vi.fn().mockResolvedValue({ data: { tree: [] } }),
      },
      issues: { listComments, createComment, updateComment, deleteComment },
    },
    paginate: (
      endpoint: (request: unknown) => Promise<unknown>,
      request: unknown,
    ) => endpoint(request),
  };
  const writeClient = {
    rest: {
      repos: { createCommitStatus },
      git: { createBlob, createTree, createCommit },
    },
    graphql: updateRefs,
  };

  vi.mocked(core.getInput).mockImplementation((name) => {
    if (name === "github-token") return "read-sentinel";
    if (name === "autofix-token") return "autofix-sentinel";
    return "";
  });
  vi.mocked(github.getOctokit).mockImplementation(
    (token) => (token === "read-sentinel" ? readClient : writeClient) as never,
  );
  mocks.getArtifact.mockImplementation(async (name) => {
    if (name !== "prek-autofix-7-3") throw new ArtifactNotFoundError(name);
    return { artifact: { id: 42 } };
  });
  mocks.downloadArtifact.mockResolvedValue({ downloadPath: "/artifact" });
  mocks.stat.mockResolvedValue({ size: 100 });
  mocks.readFile.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 1,
      source: {
        runId: 7,
        runAttempt: 3,
        repository: "base/repo",
        workflow: "prek-autofix",
        event: "pull_request",
        pullRequestNumber: 4,
        headSha: sourceSha,
      },
      operations: [
        {
          path: "fixed.txt",
          operation: "add",
          mode: "100644",
          content: "eA==",
        },
      ],
    }),
  );

  function expectNoWrites() {
    for (const write of [
      createCommitStatus,
      createComment,
      updateComment,
      deleteComment,
      createBlob,
      createTree,
      createCommit,
      updateRefs,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  }

  return {
    reviewJobs,
    associatedPullRequests,
    getWorkflowRun,
    createCommitStatus,
    createBlob,
    createCommit,
    updateRefs,
    expectNoWrites,
  };
}

describe("source run verification at the Fix Action entry point", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("skips a source run when the triggering attempt has no artifact", async () => {
    const action = setup();
    mocks.getArtifact.mockImplementation(async (name) => {
      if (name === "prek-autofix-7-2") return { artifact: { id: 41 } };
      throw new ArtifactNotFoundError(name);
    });

    const entrypoint = await import("../../packages/apply/src/index.js");
    await entrypoint.completion;
    await vi.waitFor(() =>
      expect(core.info).toHaveBeenCalledWith(
        "No prek-autofix-7-3 artifact was produced; nothing to apply.",
      ),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(mocks.downloadArtifact).not.toHaveBeenCalled();
    action.expectNoWrites();
  });

  it.each([
    [
      "a failed review",
      [{ name: "review", conclusion: "failure" }],
      "source review job did not complete successfully",
    ],
    ["no review", [], "source workflow must contain exactly one review job"],
    [
      "multiple review jobs",
      [
        { name: "review", conclusion: "success" },
        { name: "review", conclusion: "success" },
      ],
      "source workflow must contain exactly one review job",
    ],
    [
      "malformed jobs",
      [{ name: "review" }],
      "source workflow returned malformed jobs",
    ],
  ])("skips the triggering attempt with %s", async (_case, jobs, reason) => {
    const action = setup();
    action.reviewJobs.mockImplementation(async ({ attempt_number }) =>
      attempt_number === 3 ? jobs : [{ name: "review", conclusion: "success" }],
    );

    const entrypoint = await import("../../packages/apply/src/index.js");
    await entrypoint.completion;
    await vi.waitFor(() =>
      expect(core.info).toHaveBeenCalledWith(`${reason}; nothing to fix.`),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(mocks.downloadArtifact).not.toHaveBeenCalled();
    action.expectNoWrites();
  });

  it.each(["artifact", "job"])(
    "propagates unexpected %s lookup errors without writes",
    async (lookup) => {
      const action = setup();
      const endpoint =
        lookup === "artifact" ? mocks.getArtifact : action.reviewJobs;
      endpoint.mockRejectedValue(new Error("source lookup unavailable"));

      const entrypoint = await import("../../packages/apply/src/index.js");
      await entrypoint.completion;
      await vi.waitFor(() =>
        expect(core.setFailed).toHaveBeenCalledWith(
          "source lookup unavailable",
        ),
      );
      expect(mocks.downloadArtifact).not.toHaveBeenCalled();
      action.expectNoWrites();
    },
  );

  it.each([
    [
      "no open match",
      [{ ...pullRequest, state: "closed" }],
      "expected exactly one associated open pull request; found 0",
    ],
    [
      "the wrong head ref",
      [{ ...pullRequest, head: { ...pullRequest.head, ref: "other" } }],
      "expected exactly one associated open pull request; found 0",
    ],
    [
      "the wrong head repository",
      [
        {
          ...pullRequest,
          head: {
            ...pullRequest.head,
            repo: { ...pullRequest.head.repo, full_name: "other/repo" },
          },
        },
      ],
      "expected exactly one associated open pull request; found 0",
    ],
    [
      "ambiguous matches",
      [pullRequest, { ...pullRequest, number: 5 }],
      "expected exactly one associated open pull request; found 2",
    ],
    [
      "a missing head repository identity",
      [
        {
          ...pullRequest,
          head: {
            ...pullRequest.head,
            repo: { ...pullRequest.head.repo, node_id: "" },
          },
        },
      ],
      "pull request head repository identity is missing",
    ],
  ])("fails before writes for %s", async (_case, candidates, reason) => {
    const action = setup();
    action.associatedPullRequests.mockResolvedValue(candidates);

    const entrypoint = await import("../../packages/apply/src/index.js");
    await entrypoint.completion;
    await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalledWith(reason));
    expect(mocks.downloadArtifact).not.toHaveBeenCalled();
    action.expectNoWrites();
  });

  it.each([{ id: 8 }, { name: "different-workflow" }, { event: "push" }])(
    "fails before writes for an ineligible source run (%j)",
    async (override) => {
      const action = setup();
      action.getWorkflowRun.mockResolvedValue({
        data: { ...workflowRun, ...override },
      });

      const entrypoint = await import("../../packages/apply/src/index.js");
      await entrypoint.completion;
      await vi.waitFor(() =>
        expect(core.setFailed).toHaveBeenCalledWith(
          "source workflow run name or event is not eligible",
        ),
      );
      expect(mocks.downloadArtifact).not.toHaveBeenCalled();
      action.expectNoWrites();
    },
  );

  it("applies the artifact from an eligible attempt to the verified head", async () => {
    const action = setup();
    action.reviewJobs.mockImplementation(async ({ run_id, attempt_number }) =>
      run_id === 7 && attempt_number === 3
        ? [{ name: "review", conclusion: "success" }]
        : [],
    );

    const entrypoint = await import("../../packages/apply/src/index.js");
    await entrypoint.completion;
    await vi.waitFor(() =>
      expect(action.createCommitStatus).toHaveBeenCalledWith(
        expect.objectContaining({ sha: sourceSha, state: "success" }),
      ),
    );
    expect(mocks.downloadArtifact).toHaveBeenCalledWith(42, {
      findBy: {
        token: "read-sentinel",
        workflowRunId: 7,
        repositoryOwner: "base",
        repositoryName: "repo",
      },
    });
    expect(action.updateRefs).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      {
        input: {
          repositoryId: "R_base",
          refUpdates: [
            {
              name: "refs/heads/feature",
              beforeOid: sourceSha,
              afterOid: updatedSha,
              force: false,
            },
          ],
        },
      },
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("rejects a head change after creating the fix commit and before updating the ref", async () => {
    const action = setup();
    action.createCommit.mockImplementation(async () => {
      action.associatedPullRequests.mockResolvedValue([
        { ...pullRequest, head: { ...pullRequest.head, sha: updatedSha } },
      ]);
      return { data: { sha: "fix-commit" } };
    });

    const entrypoint = await import("../../packages/apply/src/index.js");
    await entrypoint.completion;
    await vi.waitFor(() =>
      expect(core.setFailed).toHaveBeenCalledWith(
        "the pull request head changed after collection",
      ),
    );
    expect(action.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: sourceSha, state: "failure" }),
    );
    expect(action.updateRefs).not.toHaveBeenCalled();
  });
});
