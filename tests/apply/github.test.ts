import { describe, expect, it, vi } from "vitest";
import {
  createMutationClient,
  createReadClient,
} from "../../packages/apply/src/github";

function octokitFixture() {
  const getTree = vi.fn();
  const octokit = {
    rest: {
      actions: { getWorkflowRun: vi.fn() },
      repos: { listPullRequestsAssociatedWithCommit: vi.fn() },
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
    octokit.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue({
      data: [{
        number: 4, state: "open", html_url: "pr",
        base: { repo: { full_name: "base/repo" } },
        head: {
          repo: {
            full_name: "fork/repo", node_id: "R_fork",
            owner: { type: "User" },
          },
          ref: "feature", sha: "head",
        },
        maintainer_can_modify: true,
      }],
    });
    const read = createReadClient(octokit as never, "base", "repo");

    await expect(read.getWorkflowRun(7)).resolves.toMatchObject({
      headRepository: "fork/repo",
    });
    await expect(read.listAssociatedPullRequests("head")).resolves.toMatchObject([
      { headRepositoryNodeId: "R_fork", headRepository: "fork/repo" },
    ]);
    expect(octokit.rest.actions.getWorkflowRun).toHaveBeenCalledWith({
      owner: "base", repo: "repo", run_id: 7,
    });
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
