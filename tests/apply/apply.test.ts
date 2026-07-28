import { describe, expect, it, vi } from "vitest";
import type { ChangeArtifact } from "../../packages/shared/src/artifact";
import {
  ApplyError,
  applyArtifact,
  maximumRawArtifactBytes,
  type MutationClient,
  type ReadClient,
} from "../../packages/apply/src/apply";

function fixture() {
  const artifact: ChangeArtifact = {
    schemaVersion: 1,
    source: {
      runId: 7,
      repository: "base/repo",
      workflow: "prek-autofix",
      event: "pull_request",
      pullRequestNumber: 4,
      headSha: "a".repeat(40),
    },
    operations: [
      { path: "new.txt", operation: "add", mode: "100644", content: "eA==" },
      { path: "old.sh", operation: "modify", mode: "100755", content: "eQ==" },
      { path: "gone.txt", operation: "delete", mode: "100644" },
    ],
  };
  const read: ReadClient = {
    getWorkflowRun: vi.fn().mockResolvedValue({
      id: 7, name: "prek-autofix", event: "pull_request",
      headSha: "a".repeat(40), headBranch: "feature", headRepository: "user/repo",
    }),
    listAssociatedPullRequests: vi.fn().mockResolvedValue([{
      number: 4, state: "open", htmlUrl: "https://example/pr/4",
      baseRepository: "base/repo", headRepository: "user/repo",
      headRepositoryNodeId: "R_head",
      headRepositoryOwnerType: "User", headRef: "feature",
      headSha: "a".repeat(40), maintainerCanModify: true,
    }]),
    getCommitTreeSha: vi.fn().mockResolvedValue("base-tree"),
    getTreeEntries: vi.fn().mockResolvedValue([
      { path: "old.sh", mode: "100755", type: "blob" },
      { path: "gone.txt", mode: "100644", type: "blob" },
    ]),
    upsertComment: vi.fn(),
    markCommentObsolete: vi.fn(),
    resolveComment: vi.fn(),
  };
  const mutation: MutationClient = {
    createBlob: vi.fn()
      .mockResolvedValueOnce("blob-new")
      .mockResolvedValueOnce("blob-old"),
    createTree: vi.fn().mockResolvedValue("tree"),
    createCommit: vi.fn().mockResolvedValue("commit"),
    updateRef: vi.fn(),
  };
  return { artifact, read, mutation };
}

const request = (artifact: ChangeArtifact) => ({
  baseRepository: "base/repo",
  runId: 7,
  artifact,
  artifactUrl: "https://example/artifact",
  sourceRunUrl: "https://example/run",
  sourceWorkflow: "prek-autofix",
  commitMessage: "fix",
});

describe("applyArtifact", () => {
  it("rejects empty artifacts and unsafe raw-size arithmetic", async () => {
    const { artifact, read, mutation } = fixture();
    artifact.operations = [];
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "no file operations",
    );
    expect(read.getWorkflowRun).not.toHaveBeenCalled();
    expect(() =>
      maximumRawArtifactBytes(Number.MAX_SAFE_INTEGER, 1),
    ).toThrow("too large");
  });

  it("creates blobs, one tree, one commit, and a non-forced ref update boundary", async () => {
    const { artifact, read, mutation } = fixture();
    await expect(applyArtifact(read, mutation, request(artifact))).resolves.toEqual({
      pullRequestNumber: 4, commitSha: "commit",
    });
    expect(read.getCommitTreeSha).toHaveBeenCalledWith(
      "base/repo", "a".repeat(40),
    );
    expect(read.getTreeEntries).toHaveBeenCalledWith(
      "base/repo",
      "base-tree",
      ["new.txt", "old.sh", "gone.txt"],
    );
    expect(mutation.createBlob).toHaveBeenCalledTimes(2);
    expect(mutation.createBlob).toHaveBeenNthCalledWith(
      1, "user/repo", "eA==",
    );
    expect(mutation.createBlob).toHaveBeenNthCalledWith(
      2, "user/repo", "eQ==",
    );
    expect(mutation.createTree).toHaveBeenCalledWith("user/repo", "base-tree", [
      { path: "new.txt", mode: "100644", type: "blob", sha: "blob-new" },
      { path: "old.sh", mode: "100755", type: "blob", sha: "blob-old" },
      { path: "gone.txt", mode: "100644", type: "blob", sha: null },
    ]);
    expect(mutation.createCommit).toHaveBeenCalledWith(
      "user/repo", "fix", "tree", "a".repeat(40),
    );
    expect(mutation.updateRef).toHaveBeenCalledWith(
      "R_head", "refs/heads/feature", "commit", "a".repeat(40),
    );
    expect(read.resolveComment).toHaveBeenCalledWith(4);
  });

  it("returns success when marker cleanup fails after a successful CAS", async () => {
    const { artifact, read, mutation } = fixture();
    vi.mocked(read.resolveComment).mockRejectedValue(
      new Error("comment permission denied"),
    );
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).resolves.toEqual({ pullRequestNumber: 4, commitSha: "commit" });
    expect(mutation.updateRef).toHaveBeenCalledOnce();
    expect(read.resolveComment).toHaveBeenCalledWith(4);
    expect(read.upsertComment).not.toHaveBeenCalled();
  });

  it("rejects forged artifact claims before reading or mutating the tree", async () => {
    const { artifact, read, mutation } = fixture();
    artifact.source.pullRequestNumber = 99;
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "artifact source claims",
    );
    expect(read.getTreeEntries).not.toHaveBeenCalled();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it.each([
    ["runId", 8],
    ["repository", "evil/repo"],
    ["workflow", "evil"],
    ["pullRequestNumber", 99],
    ["headSha", "b".repeat(40)],
  ] as const)("rejects a forged %s claim", async (field, value) => {
    const { artifact, read, mutation } = fixture();
    Object.assign(artifact.source, { [field]: value });
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow();
    expect(read.getTreeEntries).not.toHaveBeenCalled();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong workflow", { name: "other" }],
    ["wrong event", { event: "push" }],
  ])("rejects %s", async (_name, override) => {
    const { artifact, read, mutation } = fixture();
    const run = await read.getWorkflowRun(7);
    vi.mocked(read.getWorkflowRun).mockResolvedValue({ ...run, ...override });
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "not eligible",
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", []],
    ["closed", [{ state: "closed" }]],
    ["multiple", [{}, {}]],
  ])("rejects %s eligible PR candidates", async (_name, shapes) => {
    const { artifact, read, mutation } = fixture();
    const baseline = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue(
      shapes.map((shape) => ({ ...baseline, ...shape })),
    );
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "exactly one",
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong ref", { headRef: "other" }],
    ["wrong repo", { headRepository: "other/repo" }],
  ])("rejects an associated PR with %s", async (_name, override) => {
    const { artifact, read, mutation } = fixture();
    const baseline = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...baseline, ...override },
    ]);
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "exactly one",
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("treats a duplicate run after a successful update as obsolete", async () => {
    const { artifact, read, mutation } = fixture();
    const baseline = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...baseline, headSha: "b".repeat(40) },
    ]);
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "head changed",
    );
    expect(read.markCommentObsolete).toHaveBeenCalledWith(4);
    expect(read.upsertComment).not.toHaveBeenCalled();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("rejects a missing head repository node identity", async () => {
    const { artifact, read, mutation } = fixture();
    const baseline = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...baseline, headRepositoryNodeId: "" },
    ]);
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "identity is missing",
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("allows a same-repository PR without the maintainer flag", async () => {
    const { artifact, read, mutation } = fixture();
    const run = await read.getWorkflowRun(7);
    vi.mocked(read.getWorkflowRun).mockResolvedValue({
      ...run, headRepository: "base/repo",
    });
    const pr = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([{
      ...pr, headRepository: "base/repo", maintainerCanModify: false,
    }]);
    await expect(applyArtifact(read, mutation, request(artifact))).resolves.toBeDefined();
  });

  it("rejects organization-owned forks with a persistent comment", async () => {
    const { artifact, read, mutation } = fixture();
    const pr = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([{
      ...pr, headRepositoryOwnerType: "Organization",
    }]);
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "user-owned",
    );
    expect(read.upsertComment).toHaveBeenCalledOnce();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it.each([
    ["existing add", "new.txt", { path: "new.txt", mode: "100644", type: "blob" }],
    ["missing modify", "old.sh", { path: "gone.txt", mode: "100644", type: "blob" }],
    ["missing delete", "gone.txt", { path: "old.sh", mode: "100755", type: "blob" }],
  ])("rejects %s", async (_name, _path, onlyEntry) => {
    const { artifact, read, mutation } = fixture();
    vi.mocked(read.getTreeEntries).mockResolvedValue([onlyEntry]);
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("rejects a non-directory ancestor", async () => {
    const { artifact, read, mutation } = fixture();
    artifact.operations = [
      { path: "link/child", operation: "add", mode: "100644", content: "eA==" },
    ];
    vi.mocked(read.getTreeEntries).mockResolvedValue([
      { path: "link", mode: "120000", type: "blob" },
    ]);
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "non-directory",
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("rejects symlink and gitlink source entries", async () => {
    const { artifact, read, mutation } = fixture();
    artifact.operations = [
      { path: "link", operation: "modify", mode: "100644", content: "eA==" },
    ];
    vi.mocked(read.getTreeEntries).mockResolvedValue([
      { path: "link", mode: "120000", type: "blob" },
    ]);
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "not an existing regular file",
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();

    artifact.operations = [
      { path: "module", operation: "delete", mode: "100644" },
    ];
    vi.mocked(read.getTreeEntries).mockResolvedValue([
      { path: "module", mode: "160000", type: "commit" },
    ]);
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "not an existing regular file",
    );
  });

  it("comments once through the read client when an eligible fork cannot be updated", async () => {
    const { artifact, read, mutation } = fixture();
    const prs = await read.listAssociatedPullRequests("ignored");
    prs[0]!.maintainerCanModify = false;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue(prs);
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      ApplyError,
    );
    expect(read.upsertComment).toHaveBeenCalledWith(
      4, expect.stringContaining("does not allow maintainer edits"),
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("treats a ref race as terminal and posts recovery instructions", async () => {
    const { artifact, read, mutation } = fixture();
    vi.mocked(mutation.updateRef).mockRejectedValue({ status: 422 });
    await expect(applyArtifact(read, mutation, request(artifact))).rejects.toThrow(
      "branch changed",
    );
    expect(mutation.updateRef).toHaveBeenCalledTimes(1);
    expect(read.upsertComment).toHaveBeenCalledWith(
      4, expect.stringContaining("Download the generated artifact"),
    );
  });

  it.each([409, 422])(
    "attempts the ref update exactly once for status %i",
    async (status) => {
      const { artifact, read, mutation } = fixture();
      vi.mocked(mutation.updateRef).mockRejectedValue({ status, message: "PAT=secret" });
      await expect(applyArtifact(read, mutation, request(artifact))).rejects.not.toThrow(
        "secret",
      );
      expect(mutation.updateRef).toHaveBeenCalledTimes(1);
      expect(read.upsertComment).toHaveBeenCalledOnce();
    },
  );

  it("sanitizes a mutation failure and posts recovery", async () => {
    const { artifact, read, mutation } = fixture();
    vi.mocked(mutation.createBlob).mockReset().mockRejectedValue(
      new Error("remote said token ghp_secret"),
    );
    const outcome = applyArtifact(read, mutation, request(artifact));
    await expect(outcome).rejects.toThrow("GitHub rejected the fix commit");
    expect(read.upsertComment).toHaveBeenCalled();
    expect(vi.mocked(read.upsertComment).mock.calls[0]?.[1]).not.toContain(
      "ghp_secret",
    );
  });
});
