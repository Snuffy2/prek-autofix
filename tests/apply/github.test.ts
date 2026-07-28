import { describe, expect, it, vi } from "vitest";
import {
  createMutationClient,
  createReadClient,
} from "../../packages/apply/src/github";
import { MAX_TOTAL_PATH_COMPONENTS } from "../../packages/shared/src/artifact";

function octokitFixture() {
  const getTree = vi.fn();
  const octokit = {
    rest: {
      actions: { getWorkflowRun: vi.fn() },
      repos: { listPullRequestsAssociatedWithCommit: vi.fn() },
      pulls: { get: vi.fn() },
      git: {
        getCommit: vi.fn(),
        getTree,
        createBlob: vi.fn(),
        createTree: vi.fn(),
        createCommit: vi.fn(),
      },
      issues: {
        listComments: vi.fn(),
        updateComment: vi.fn(),
        createComment: vi.fn(),
        deleteComment: vi.fn(),
      },
    },
    paginate: vi.fn(),
    graphql: vi.fn(),
  };
  return { octokit, getTree };
}

describe("GitHub apply adapters", () => {
  it("maps workflow and fork PR reads through the base repository", async () => {
    const { octokit } = octokitFixture();
    octokit.rest.actions.getWorkflowRun.mockResolvedValue({ data: {
      id: 7, name: "prek-autofix", event: "pull_request",
      head_sha: "head", head_branch: "feature",
      head_repository: { full_name: "fork/repo" },
    } });
    octokit.paginate.mockResolvedValue([{
        number: 4, state: "open", html_url: "pr",
        base: { repo: { full_name: "base/repo" } },
        head: {
          repo: {
            full_name: "fork/repo", node_id: "R_fork",
            owner: { type: "User" },
          },
          ref: "feature", sha: "head",
        },
      },
    ]);
    octokit.rest.pulls.get.mockResolvedValue({
      data: { maintainer_can_modify: true },
    });
    const read = createReadClient(octokit as never, "base", "repo");

    await expect(read.getWorkflowRun(7)).resolves.toMatchObject({
      headRepository: "fork/repo",
    });
    await expect(read.listAssociatedPullRequests("head")).resolves.toMatchObject([
      {
        headRepositoryNodeId: "R_fork",
        headRepository: "fork/repo",
        maintainerCanModify: true,
      },
    ]);
    expect(octokit.rest.actions.getWorkflowRun).toHaveBeenCalledWith({
      owner: "base", repo: "repo", run_id: 7,
    });
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.repos.listPullRequestsAssociatedWithCommit,
      { owner: "base", repo: "repo", commit_sha: "head", per_page: 100 },
    );
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: "base", repo: "repo", pull_number: 4,
    });
  });

  it("maps same-repository PRs without fetching PR details", async () => {
    const { octokit } = octokitFixture();
    octokit.paginate.mockResolvedValue([{
      number: 5,
      state: "open",
      base: { repo: { full_name: "base/repo" } },
      head: {
        repo: {
          full_name: "base/repo",
          node_id: "R_base",
          owner: { type: "Organization" },
        },
        ref: "feature",
        sha: "head",
      },
    }]);
    const read = createReadClient(octokit as never, "base", "repo");

    await expect(read.listAssociatedPullRequests("head")).resolves.toEqual([{
      number: 5,
      state: "open",
      baseRepository: "base/repo",
      headRepository: "base/repo",
      headRepositoryNodeId: "R_base",
      headRepositoryOwnerType: "Organization",
      headRef: "feature",
      headSha: "head",
      maintainerCanModify: false,
    }]);
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  it("walks only affected paths through the base repository and caches shared ancestors", async () => {
    const { octokit, getTree } = octokitFixture();
    getTree
      .mockResolvedValueOnce({ data: {
        truncated: false,
        tree: [
          { path: "src", mode: "040000", type: "tree", sha: "src-tree" },
          { path: "unrelated-huge", mode: "040000", type: "tree", sha: "huge" },
        ],
      } })
      .mockResolvedValueOnce({ data: {
        truncated: false,
        tree: [
          { path: "a.ts", mode: "100644", type: "blob", sha: "a" },
          { path: "b.ts", mode: "100644", type: "blob", sha: "b" },
        ],
      } });
    const read = createReadClient(octokit as never, "base", "repo");

    octokit.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "root" } },
    });
    await expect(
      read.getCommitTreeSha("base/repo", "head"),
    ).resolves.toBe("root");
    await expect(
      read.getTreeEntries("base/repo", "root", ["src/a.ts", "src/b.ts"]),
    ).resolves.toEqual([
      { path: "src", mode: "040000", type: "tree" },
      { path: "src/a.ts", mode: "100644", type: "blob" },
      { path: "src/b.ts", mode: "100644", type: "blob" },
    ]);
    expect(octokit.rest.git.getCommit).toHaveBeenCalledWith({
      owner: "base", repo: "repo", commit_sha: "head",
    });
    expect(getTree).toHaveBeenCalledTimes(2);
    expect(getTree).toHaveBeenCalledWith({
      owner: "base", repo: "repo", tree_sha: "root",
    });
    expect(getTree.mock.calls.flatMap((call) => Object.keys(call[0]))).not
      .toContain("recursive");
  });

  it("rejects even a truncated non-recursive directory response", async () => {
    const { octokit, getTree } = octokitFixture();
    getTree.mockResolvedValue({ data: { truncated: true, tree: [] } });
    const read = createReadClient(octokit as never, "base", "repo");
    await expect(
      read.getTreeEntries("fork/repo", "root", ["small.txt"]),
    ).rejects.toThrow("truncated");
  });

  it("rejects over-budget paths before making a Git tree request", async () => {
    const { octokit, getTree } = octokitFixture();
    const read = createReadClient(octokit as never, "base", "repo");
    const pathCount = 100;
    const componentsPerPath = Math.floor(
      MAX_TOTAL_PATH_COMPONENTS / pathCount,
    );
    const remainder = MAX_TOTAL_PATH_COMPONENTS % pathCount;
    const paths = Array.from({ length: pathCount }, (_, pathIndex) =>
      Array.from(
        {
          length:
            componentsPerPath +
            (pathIndex < remainder ? 1 : 0) +
            (pathIndex === pathCount - 1 ? 1 : 0),
        },
        (_, componentIndex) => `p${pathIndex}-${componentIndex}`,
      ).join("/"),
    );

    await expect(
      read.getTreeEntries("base/repo", "root", paths),
    ).rejects.toThrow(`more than ${MAX_TOTAL_PATH_COMPONENTS} total components`);
    expect(getTree).not.toHaveBeenCalled();
  });

  it("routes Git Data writes to the fork and performs exact-head GraphQL CAS", async () => {
    const { octokit } = octokitFixture();
    octokit.rest.git.createBlob.mockResolvedValue({ data: { sha: "blob" } });
    octokit.rest.git.createTree.mockResolvedValue({ data: { sha: "tree" } });
    octokit.rest.git.createCommit.mockResolvedValue({ data: { sha: "commit" } });
    const mutation = createMutationClient(octokit as never);
    await mutation.createBlob("fork/repo", "eA==");
    await mutation.createTree("fork/repo", "base", []);
    await mutation.createCommit("fork/repo", "fix", "tree", "before");
    await mutation.updateRef("R_fork", "refs/heads/feature", "after", "before");

    expect(octokit.rest.git.createBlob).toHaveBeenCalledWith({
      owner: "fork", repo: "repo", content: "eA==", encoding: "base64",
    });
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining("updateRefs"),
      { input: {
        repositoryId: "R_fork",
        refUpdates: [{
          name: "refs/heads/feature",
          beforeOid: "before",
          afterOid: "after",
          force: false,
        }],
      } },
    );
  });

  it("resolves only an owned existing marker and never creates success comments", async () => {
    const { octokit } = octokitFixture();
    octokit.paginate.mockResolvedValue([
      {
        id: 1, user: { login: "contributor" },
        body: "<!-- prek-autofix-result --> spoof",
      },
      {
        id: 2, user: { login: "github-actions[bot]" },
        body: "<!-- prek-autofix-result --> recovery",
      },
    ]);
    const read = createReadClient(octokit as never, "base", "repo");
    await read.resolveComment(4);
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 2 }),
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();

    octokit.rest.issues.updateComment.mockClear();
    octokit.paginate.mockResolvedValue([]);
    await read.resolveComment(4);
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("marks only an owned existing marker obsolete without creating a comment", async () => {
    const { octokit } = octokitFixture();
    octokit.paginate.mockResolvedValue([
      {
        id: 1, user: { login: "contributor" },
        body: "<!-- prek-autofix-result --> spoof",
      },
      {
        id: 2, user: { login: "github-actions[bot]" },
        body: "<!-- prek-autofix-result --> applied successfully",
      },
    ]);
    const read = createReadClient(octokit as never, "base", "repo");
    await read.markCommentObsolete(4);
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      owner: "base",
      repo: "repo",
      comment_id: 2,
      body: expect.stringMatching(/obsolete.*No action is required/s),
    });
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();

    octokit.rest.issues.updateComment.mockClear();
    octokit.paginate.mockResolvedValue([
      {
        id: 1, user: { login: "contributor" },
        body: "<!-- prek-autofix-result --> spoof",
      },
    ]);
    await read.markCommentObsolete(4);
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it.each([
    ["recovery", "upsertComment", "recovery instructions"],
    ["success", "resolveComment", undefined],
    ["obsolete", "markCommentObsolete", undefined],
  ] as const)(
    "canonicalizes duplicate owned markers for %s",
    async (_disposition, method, suppliedBody) => {
      const { octokit } = octokitFixture();
      octokit.paginate.mockResolvedValue([
        {
          id: 9, user: { login: "github-actions[bot]" },
          body: "<!-- prek-autofix-result --> old recovery",
        },
        {
          id: 1, user: { login: "contributor" },
          body: "<!-- prek-autofix-result --> spoof",
        },
        {
          id: 3, user: { login: "github-actions[bot]" },
          body: "<!-- prek-autofix-result --> canonical",
        },
        {
          id: 7, user: { login: "github-actions[bot]" },
          body: "<!-- prek-autofix-result --> contradictory recovery",
        },
      ]);
      const read = createReadClient(octokit as never, "base", "repo");

      if (method === "upsertComment") {
        await read.upsertComment(4, suppliedBody!);
      } else {
        await read[method](4);
      }

      expect(octokit.rest.issues.deleteComment).toHaveBeenNthCalledWith(1, {
        owner: "base", repo: "repo", comment_id: 7,
      });
      expect(octokit.rest.issues.deleteComment).toHaveBeenNthCalledWith(2, {
        owner: "base", repo: "repo", comment_id: 9,
      });
      expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 3 }),
      );
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(
        octokit.rest.issues.deleteComment.mock.invocationCallOrder[1],
      ).toBeLessThan(
        octokit.rest.issues.updateComment.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("fails before updating the canonical marker when duplicate deletion fails", async () => {
    const { octokit } = octokitFixture();
    octokit.paginate.mockResolvedValue([
      {
        id: 2, user: { login: "github-actions[bot]" },
        body: "<!-- prek-autofix-result --> canonical",
      },
      {
        id: 4, user: { login: "github-actions[bot]" },
        body: "<!-- prek-autofix-result --> duplicate",
      },
    ]);
    octokit.rest.issues.deleteComment.mockRejectedValue(
      new Error("comment deletion denied"),
    );
    const read = createReadClient(octokit as never, "base", "repo");

    await expect(read.resolveComment(4)).rejects.toThrow("deletion denied");
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("creates only recovery when no owned marker exists", async () => {
    const { octokit } = octokitFixture();
    octokit.paginate.mockResolvedValue([
      {
        id: 1, user: { login: "contributor" },
        body: "<!-- prek-autofix-result --> spoof",
      },
    ]);
    const read = createReadClient(octokit as never, "base", "repo");

    await read.resolveComment(4);
    await read.markCommentObsolete(4);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();

    await read.upsertComment(4, "recovery");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "base", repo: "repo", issue_number: 4, body: "recovery",
    });
  });

  it("propagates GraphQL branch-protection errors without leaking into reads", async () => {
    const { octokit } = octokitFixture();
    octokit.graphql.mockRejectedValue(new Error("branch protection"));
    const mutation = createMutationClient(octokit as never);
    await expect(
      mutation.updateRef("R", "refs/heads/x", "after", "before"),
    ).rejects.toThrow("branch protection");
    expect(octokit.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
  });
});
