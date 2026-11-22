import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const artifactApi = vi.hoisted(() => ({
  getArtifact: vi.fn(),
  downloadArtifact: vi.fn(),
}));

vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    getArtifact = artifactApi.getArtifact;
    downloadArtifact = artifactApi.downloadArtifact;
  },
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
vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({ size: 500 }),
  readFile: vi.fn(),
}));

const sourceSha = "a".repeat(40);
const fixSha = "b".repeat(40);
const fixRunUrl = "https://github.example/base/repo/actions/runs/99";
const sourceRunUrl = "https://github.example/base/repo/actions/runs/7";
const existingComment = {
  id: 12,
  body: "<!-- prek-autofix-result -->",
  user: { login: "github-actions[bot]" },
};
const artifact = {
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
    { path: "fixed.txt", operation: "add", mode: "100644", content: "eA==" },
  ],
};

function githubFixture(useFallback = false) {
  const headRepository = useFallback ? "base/repo" : "fork/repo";
  const pullRequest = {
    number: 4,
    state: "open",
    base: { repo: { full_name: "base/repo" } },
    head: {
      repo: {
        full_name: headRepository,
        node_id: "R_fork",
        owner: { type: "User" },
      },
      ref: "feature",
      sha: sourceSha,
    },
  };
  const listJobs = vi
    .fn()
    .mockResolvedValue([{ name: "review", conclusion: "success" }]);
  const listPullRequests = vi.fn().mockResolvedValue([pullRequest]);
  const listComments = vi.fn().mockResolvedValue([]);
  const read = {
    rest: {
      actions: {
        getWorkflowRun: vi.fn().mockResolvedValue({
          data: {
            id: 7,
            name: "prek-autofix",
            event: "pull_request",
            head_sha: sourceSha,
            head_branch: "feature",
            head_repository: { full_name: headRepository },
          },
        }),
        listJobsForWorkflowRunAttempt: listJobs,
      },
      repos: { listPullRequestsAssociatedWithCommit: listPullRequests },
      pulls: {
        get: vi
          .fn()
          .mockResolvedValue({ data: { maintainer_can_modify: true } }),
      },
      git: {
        getCommit: vi
          .fn()
          .mockResolvedValue({ data: { tree: { sha: "base-tree" } } }),
        getTree: vi.fn().mockResolvedValue({ data: { tree: [] } }),
      },
      issues: {
        listComments,
        createComment: vi.fn(),
        updateComment: vi.fn(),
      },
    },
    paginate: (endpoint: () => Promise<unknown>) => endpoint(),
  };
  const write = {
    rest: {
      repos: { createCommitStatus: vi.fn() },
      git: {
        createBlob: vi.fn().mockResolvedValue({ data: { sha: "blob" } }),
        createTree: vi.fn().mockResolvedValue({ data: { sha: "fix-tree" } }),
        createCommit: vi.fn().mockResolvedValue({ data: { sha: fixSha } }),
      },
    },
    graphql: vi.fn(),
  };
  const readWithWriteAccess = {
    ...read,
    graphql: write.graphql,
    rest: {
      ...read.rest,
      repos: { ...read.rest.repos, ...write.rest.repos },
      git: { ...read.rest.git, ...write.rest.git },
    },
  };
  // Separate client surfaces ensure statuses and comments use their own tokens.
  vi.mocked(github.getOctokit).mockImplementation((token) => {
    if (token === "read-credential")
      return (useFallback ? readWithWriteAccess : read) as never;
    if (token === "autofix-credential") return write as never;
    throw new Error("Unexpected test credential");
  });
  return { read, write, pullRequest };
}

describe("fix Action reporting", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(core.getInput).mockImplementation((name) => {
      if (name === "github-token") return "read-credential";
      if (name === "autofix-token") return "autofix-credential";
      return "";
    });
    artifactApi.getArtifact.mockResolvedValue({ artifact: { id: 42 } });
    artifactApi.downloadArtifact.mockResolvedValue({
      downloadPath: "/artifact",
    });
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(artifact));
  });

  it("publishes one recovery comment with the fork permission reason and both run links", async () => {
    const { read, write } = githubFixture();
    read.rest.pulls.get.mockResolvedValue({
      data: { maintainer_can_modify: false },
    });

    await import("../../packages/apply/src/index.js");
    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith(
        "the fork does not allow maintainer edits",
      );
    });

    const createComment = read.rest.issues.createComment;
    expect(createComment).toHaveBeenCalledOnce();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 4,
        body: expect.stringContaining(
          "the fork does not allow maintainer edits",
        ),
      }),
    );
    const body = createComment.mock.calls[0]![0].body;
    expect(body).toContain(fixRunUrl);
    expect(body).toContain(sourceRunUrl);
    expect(write.graphql).not.toHaveBeenCalled();
  });

  it("keeps a stale result when GitHub denies marking an existing recovery comment obsolete", async () => {
    const { read, write, pullRequest } = githubFixture();
    read.rest.repos.listPullRequestsAssociatedWithCommit
      .mockResolvedValueOnce([pullRequest])
      .mockResolvedValueOnce([
        { ...pullRequest, head: { ...pullRequest.head, sha: fixSha } },
      ]);
    read.rest.issues.listComments.mockResolvedValue([existingComment]);
    read.rest.issues.updateComment.mockRejectedValue(
      new Error("comment API denied"),
    );

    await import("../../packages/apply/src/index.js");
    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith(
        "the pull request head changed after collection",
      );
    });

    expect(write.graphql).not.toHaveBeenCalled();
    expect(read.rest.issues.createComment).not.toHaveBeenCalled();
    expect(read.rest.issues.updateComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        comment_id: existingComment.id,
        body: expect.stringContaining("is obsolete"),
      }),
    );
    expect(write.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failure",
        sha: sourceSha,
        description: "Pull request head changed",
      }),
    );
  });

  it("preserves the completed branch update when GitHub denies success reporting", async () => {
    const { read, write } = githubFixture();
    read.rest.issues.listComments.mockResolvedValue([existingComment]);
    read.rest.issues.updateComment.mockRejectedValue(
      new Error("comment API denied"),
    );
    write.rest.repos.createCommitStatus
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("status API denied"));

    await import("../../packages/apply/src/index.js");
    await vi.waitFor(() => {
      expect(core.warning).toHaveBeenCalledWith(
        "prek-autofix could not publish its resolved pull request recovery comment",
      );
    });

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(write.graphql).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      input: {
        repositoryId: "R_fork",
        refUpdates: [
          {
            name: "refs/heads/feature",
            beforeOid: sourceSha,
            afterOid: fixSha,
            force: false,
          },
        ],
      },
    });
    expect(write.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "success",
        sha: sourceSha,
      }),
    );
    expect(read.rest.issues.updateComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        comment_id: existingComment.id,
        body: expect.stringContaining(
          "fixed the generated changes successfully",
        ),
      }),
    );
    expect(read.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("keeps the branch-update reason when one recovery request is denied", async () => {
    const { read, write } = githubFixture();
    write.graphql.mockRejectedValue({
      status: 422,
      message: "upstream branch response",
    });
    read.rest.issues.createComment.mockRejectedValue(
      new Error("upstream comment response"),
    );

    await import("../../packages/apply/src/index.js");
    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith(
        "GitHub could not update the pull request branch because it changed or the update was not allowed",
      );
    });

    expect(write.graphql).toHaveBeenCalledOnce();
    expect(read.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        issue_number: 4,
        body: expect.stringContaining(
          "because it changed or the update was not allowed",
        ),
      }),
    );
    const body = read.rest.issues.createComment.mock.calls[0]![0].body;
    expect(body).toContain(fixRunUrl);
    expect(body).toContain(sourceRunUrl);
    expect(body).not.toContain("upstream");
  });

  it("keeps raw artifact download errors out of the Action result and reports to the verified source commit", async () => {
    const { read, write } = githubFixture();
    artifactApi.downloadArtifact.mockRejectedValue(
      new Error("private upstream download details"),
    );

    await import("../../packages/apply/src/index.js");
    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith(
        "the fix action failed unexpectedly",
      );
    });

    expect(
      write.rest.repos.createCommitStatus.mock.calls.map(([status]) => status),
    ).toEqual([
      expect.objectContaining({
        state: "pending",
        sha: sourceSha,
        target_url: fixRunUrl,
      }),
      expect.objectContaining({
        state: "failure",
        sha: sourceSha,
        target_url: fixRunUrl,
      }),
    ]);
    expect(read.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        issue_number: 4,
        body: expect.not.stringContaining("private upstream download details"),
      }),
    );
    expect(write.graphql).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses only an existing recovery marker after success (marker present: %s)",
    async (hasMarker) => {
      const { read, write } = githubFixture();
      if (hasMarker)
        read.rest.issues.listComments.mockResolvedValue([existingComment]);

      await import("../../packages/apply/src/index.js");
      await vi.waitFor(() => {
        expect(write.rest.repos.createCommitStatus).toHaveBeenCalledWith(
          expect.objectContaining({ state: "success", sha: sourceSha }),
        );
      });

      expect(write.graphql).toHaveBeenCalledOnce();
      expect(core.setFailed).not.toHaveBeenCalled();
      expect(read.rest.issues.createComment).not.toHaveBeenCalled();
      if (hasMarker) {
        expect(read.rest.issues.updateComment).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            comment_id: existingComment.id,
            body: expect.stringContaining(
              "fixed the generated changes successfully",
            ),
          }),
        );
      } else {
        expect(read.rest.issues.updateComment).not.toHaveBeenCalled();
      }
    },
  );

  it("does not create a recovery comment when an already stale artifact has no marker", async () => {
    const { read, write, pullRequest } = githubFixture();
    read.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue([
      { ...pullRequest, head: { ...pullRequest.head, sha: fixSha } },
    ]);

    await import("../../packages/apply/src/index.js");
    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith(
        "the pull request head changed after collection",
      );
    });

    expect(read.rest.issues.createComment).not.toHaveBeenCalled();
    expect(read.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(write.rest.git.createCommit).not.toHaveBeenCalled();
    expect(write.graphql).not.toHaveBeenCalled();
  });

  it("reports an invalid artifact on the verified source commit", async () => {
    const { read, write } = githubFixture();
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        ...artifact,
        schemaVersion: 999,
        source: { ...artifact.source, headSha: fixSha },
      }),
    );

    await import("../../packages/apply/src/index.js");
    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith(
        "the generated artifact failed security validation",
      );
    });

    expect(
      write.rest.repos.createCommitStatus.mock.calls.map(([status]) => status),
    ).toEqual([
      expect.objectContaining({ state: "pending", sha: sourceSha }),
      expect.objectContaining({
        state: "failure",
        sha: sourceSha,
        description: "Generated artifact failed validation",
      }),
    ]);
    expect(read.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        issue_number: 4,
        body: expect.stringContaining(
          "the generated artifact failed security validation",
        ),
      }),
    );
    expect(write.rest.git.createBlob).not.toHaveBeenCalled();
    expect(write.graphql).not.toHaveBeenCalled();
  });

  it("reports when configured limits cannot safely bound artifact JSON", async () => {
    const { read, write } = githubFixture();
    vi.mocked(core.getInput).mockImplementation((name) => {
      if (name === "github-token") return "read-credential";
      if (name === "autofix-token") return "autofix-credential";
      if (name === "max-bytes") return "9007199254740991";
      return "";
    });

    await import("../../packages/apply/src/index.js");
    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith(
        "configured limits are too large to safely bound artifact JSON",
      );
    });

    expect(
      write.rest.repos.createCommitStatus.mock.calls.map(([status]) => status),
    ).toEqual([
      expect.objectContaining({ state: "pending", sha: sourceSha }),
      expect.objectContaining({ state: "failure", sha: sourceSha }),
    ]);
    expect(read.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        issue_number: 4,
        body: expect.stringContaining(
          "Reduce the `max-files` or `max-bytes` input",
        ),
      }),
    );
    expect(write.rest.git.createBlob).not.toHaveBeenCalled();
    expect(write.graphql).not.toHaveBeenCalled();
  });

  it.each([
    {
      input: "max-files",
      operations: [
        artifact.operations[0],
        { ...artifact.operations[0], path: "second.txt" },
      ],
      message: "artifact has 2 files; maximum is 1",
    },
    {
      input: "max-bytes",
      operations: [{ ...artifact.operations[0], content: "eHk=" }],
      message: "artifact content exceeds maximum of 1 bytes",
    },
  ])(
    "reports an artifact that exceeds $input",
    async ({ input, operations, message }) => {
      const { read, write } = githubFixture();
      vi.mocked(core.getInput).mockImplementation((name) => {
        if (name === "github-token") return "read-credential";
        if (name === "autofix-token") return "autofix-credential";
        if (name === input) return "1";
        return "";
      });
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({ ...artifact, operations }),
      );

      await import("../../packages/apply/src/index.js");
      await vi.waitFor(() => {
        expect(core.setFailed).toHaveBeenCalledWith(message);
      });

      expect(
        write.rest.repos.createCommitStatus.mock.calls.map(
          ([status]) => status,
        ),
      ).toEqual([
        expect.objectContaining({ state: "pending", sha: sourceSha }),
        expect.objectContaining({
          state: "failure",
          sha: sourceSha,
          description: "Generated artifact failed validation",
        }),
      ]);
      expect(read.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          issue_number: 4,
          body: expect.stringContaining(
            "the generated artifact failed security validation",
          ),
        }),
      );
      expect(write.rest.git.createBlob).not.toHaveBeenCalled();
      expect(write.graphql).not.toHaveBeenCalled();
    },
  );

  it("reports missing write permission when the built-in credential is selected", async () => {
    const { read, write } = githubFixture(true);
    vi.mocked(core.getInput).mockImplementation((name) =>
      name === "github-token" ? "read-credential" : "",
    );
    write.rest.git.createBlob.mockRejectedValue({
      status: 403,
      message: "private upstream permission details",
    });

    await import("../../packages/apply/src/index.js");
    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith(
        "GITHUB_TOKEN could not update the pull request branch; grant contents: write or configure PREK_AUTOFIX_TOKEN",
      );
    });

    expect(github.getOctokit).not.toHaveBeenCalledWith("autofix-credential");
    expect(write.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failure", sha: sourceSha }),
    );
    expect(read.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        body: expect.stringContaining("grant contents: write"),
      }),
    );
    expect(read.rest.issues.createComment.mock.calls[0]![0].body).not.toContain(
      "private upstream permission details",
    );
    expect(write.graphql).not.toHaveBeenCalled();
  });
});
