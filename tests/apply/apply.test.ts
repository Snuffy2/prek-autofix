import { describe, expect, it, vi } from "vitest";
import type { ChangeArtifact } from "../../packages/shared/src/artifact";
import {
  applyArtifact,
  maximumRawArtifactBytes,
  type MutationClient,
  type ReadClient,
  type ResolvedSource,
} from "../../packages/apply/src/apply";

function fixture() {
  const artifact: ChangeArtifact = {
    schemaVersion: 1,
    source: {
      runId: 7,
      runAttempt: 2,
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
  const source: ResolvedSource = {
    run: {
      id: 7,
      name: "prek-autofix",
      event: "pull_request",
      headSha: "a".repeat(40),
      headBranch: "feature",
      headRepository: "user/repo",
    },
    pullRequest: {
      number: 4,
      state: "open",
      baseRepository: "base/repo",
      headRepository: "user/repo",
      headRepositoryNodeId: "R_head",
      headRepositoryOwnerType: "User",
      headRef: "feature",
      headSha: "a".repeat(40),
    },
  };
  const read: ReadClient = {
    getWorkflowRun: vi.fn().mockResolvedValue(source.run),
    listAssociatedPullRequests: vi.fn().mockResolvedValue([source.pullRequest]),
    getMaintainerCanModify: vi.fn().mockResolvedValue(true),
    getCommitTreeSha: vi.fn().mockResolvedValue("base-tree"),
    getTreeEntries: vi.fn().mockResolvedValue([
      { path: "old.sh", mode: "100755", type: "blob" },
      { path: "gone.txt", mode: "100644", type: "blob" },
    ]),
  };
  const mutation: MutationClient = {
    createBlob: vi
      .fn()
      .mockResolvedValueOnce("blob-new")
      .mockResolvedValueOnce("blob-old"),
    createTree: vi.fn().mockResolvedValue("tree"),
    createCommit: vi.fn().mockResolvedValue("commit"),
    updateRef: vi.fn(),
  };
  const request = () => ({
    baseRepository: "base/repo",
    runAttempt: 2,
    artifact,
    commitMessage: "fix",
    mutationTokenUsedGithubFallback: false,
    source,
  });
  return { artifact, read, mutation, request, source };
}

describe("applyArtifact", () => {
  it("revalidates a source resolved before artifact and token processing", async () => {
    const { read, mutation, request } = fixture();

    await expect(applyArtifact(read, mutation, request())).resolves.toEqual({
      pullRequestNumber: 4,
      commitSha: "commit",
    });
    expect(read.getWorkflowRun).toHaveBeenCalledExactlyOnceWith(7);
    expect(read.listAssociatedPullRequests).toHaveBeenCalledWith(
      "a".repeat(40),
    );
  });

  it("rejects empty artifacts and unsafe raw-size arithmetic", async () => {
    const { artifact, read, mutation, request } = fixture();
    artifact.operations = [];
    await expect(applyArtifact(read, mutation, request())).rejects.toThrow(
      "no file operations",
    );
    expect(read.getWorkflowRun).not.toHaveBeenCalled();
    expect(() => maximumRawArtifactBytes(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      "too large",
    );
  });

  it("creates blobs, one tree, one commit, and a non-forced ref update boundary", async () => {
    const { read, mutation, request } = fixture();
    await expect(applyArtifact(read, mutation, request())).resolves.toEqual({
      pullRequestNumber: 4,
      commitSha: "commit",
    });
    expect(read.getMaintainerCanModify).toHaveBeenCalledTimes(2);
    expect(read.getMaintainerCanModify).toHaveBeenNthCalledWith(1, 4);
    expect(read.getMaintainerCanModify).toHaveBeenNthCalledWith(2, 4);
    expect(read.getCommitTreeSha).toHaveBeenCalledWith(
      "base/repo",
      "a".repeat(40),
    );
    expect(read.getTreeEntries).toHaveBeenCalledWith("base/repo", "base-tree", [
      "new.txt",
      "old.sh",
      "gone.txt",
    ]);
    expect(mutation.createBlob).toHaveBeenCalledTimes(2);
    expect(mutation.createBlob).toHaveBeenCalledWith("user/repo", "eA==");
    expect(mutation.createBlob).toHaveBeenCalledWith("user/repo", "eQ==");
    expect(mutation.createTree).toHaveBeenCalledWith("user/repo", "base-tree", [
      { path: "new.txt", mode: "100644", type: "blob", sha: "blob-new" },
      { path: "old.sh", mode: "100755", type: "blob", sha: "blob-old" },
      { path: "gone.txt", mode: "100644", type: "blob", sha: null },
    ]);
    expect(mutation.createCommit).toHaveBeenCalledWith(
      "user/repo",
      "fix",
      "tree",
      "a".repeat(40),
    );
    expect(mutation.updateRef).toHaveBeenCalledWith(
      "R_head",
      "refs/heads/feature",
      "commit",
      "a".repeat(40),
    );
  });

  it.each([
    ["runId", 8],
    ["runAttempt", 3],
    ["repository", "evil/repo"],
    ["workflow", "evil"],
    ["pullRequestNumber", 99],
    ["headSha", "b".repeat(40)],
  ] as const)("rejects a forged %s claim", async (field, value) => {
    const { artifact, read, mutation, request } = fixture();
    Object.assign(artifact.source, { [field]: value });
    await expect(
      applyArtifact(read, mutation, request()),
    ).rejects.toMatchObject({ outcome: { kind: "artifact-source-mismatch" } });
    expect(read.getTreeEntries).not.toHaveBeenCalled();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("treats a duplicate run after a successful update as obsolete", async () => {
    const { read, mutation, request, source } = fixture();
    source.pullRequest.headSha = "b".repeat(40);
    source.pullRequest.headRepositoryOwnerType = "Organization";
    await expect(
      applyArtifact(read, mutation, {
        ...request(),
        mutationTokenUsedGithubFallback: true,
      }),
    ).rejects.toThrow("stale-head");
    expect(read.getMaintainerCanModify).not.toHaveBeenCalled();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("allows a same-repository PR without the maintainer flag", async () => {
    const { read, mutation, request, source } = fixture();
    source.run.headRepository = "base/repo";
    source.pullRequest.headRepository = "base/repo";
    await expect(
      applyArtifact(read, mutation, {
        ...request(),
        mutationTokenUsedGithubFallback: true,
      }),
    ).resolves.toBeDefined();
    expect(read.getMaintainerCanModify).not.toHaveBeenCalled();
  });

  it("does not update a pull request that closes after initial validation", async () => {
    const { read, mutation, request, source } = fixture();
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...source.pullRequest, state: "closed" },
    ]);

    await expect(
      applyArtifact(read, mutation, request()),
    ).rejects.toMatchObject({
      outcome: { kind: "source-ineligible" },
    });
    expect(mutation.createCommit).toHaveBeenCalledOnce();
    expect(mutation.updateRef).not.toHaveBeenCalled();
  });

  it("treats a head change during final revalidation as obsolete", async () => {
    const { read, mutation, request, source } = fixture();
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...source.pullRequest, headSha: "b".repeat(40) },
    ]);

    await expect(
      applyArtifact(read, mutation, request()),
    ).rejects.toMatchObject({
      outcome: { kind: "stale-head" },
    });
    expect(mutation.updateRef).not.toHaveBeenCalled();
  });

  it("revalidates that a fork remains user-owned", async () => {
    const { read, mutation, request, source } = fixture();
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...source.pullRequest, headRepositoryOwnerType: "Organization" },
    ]);

    await expect(
      applyArtifact(read, mutation, request()),
    ).rejects.toMatchObject({
      outcome: { kind: "source-changed" },
    });
    expect(mutation.updateRef).not.toHaveBeenCalled();
  });

  it("does not update a fork after maintainer edits are revoked", async () => {
    const { read, mutation, request } = fixture();
    vi.mocked(read.getMaintainerCanModify)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      applyArtifact(read, mutation, request()),
    ).rejects.toMatchObject({
      outcome: { kind: "fork-edits-revoked" },
    });
    expect(read.getMaintainerCanModify).toHaveBeenCalledTimes(2);
    expect(mutation.createCommit).toHaveBeenCalledOnce();
    expect(mutation.updateRef).not.toHaveBeenCalled();
  });

  it("rejects the built-in token for a cross-repository update", async () => {
    const { read, mutation, request } = fixture();
    await expect(
      applyArtifact(read, mutation, {
        ...request(),
        mutationTokenUsedGithubFallback: true,
      }),
    ).rejects.toThrow("fork-token-required");
    expect(read.getMaintainerCanModify).not.toHaveBeenCalled();
    expect(mutation.createBlob).not.toHaveBeenCalled();
    expect(mutation.createTree).not.toHaveBeenCalled();
    expect(mutation.createCommit).not.toHaveBeenCalled();
    expect(mutation.updateRef).not.toHaveBeenCalled();
  });

  it("rejects organization-owned forks", async () => {
    const { read, mutation, request, source } = fixture();
    source.pullRequest.headRepositoryOwnerType = "Organization";
    await expect(
      applyArtifact(read, mutation, request()),
    ).rejects.toMatchObject({
      outcome: { kind: "fork-owner-ineligible" },
    });
    expect(read.getMaintainerCanModify).not.toHaveBeenCalled();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it.each([
    [
      "existing add",
      "new.txt",
      { path: "new.txt", mode: "100644", type: "blob" },
    ],
    [
      "missing modify",
      "old.sh",
      { path: "gone.txt", mode: "100644", type: "blob" },
    ],
    [
      "missing delete",
      "gone.txt",
      { path: "old.sh", mode: "100755", type: "blob" },
    ],
  ])("rejects %s", async (_name, _path, onlyEntry) => {
    const { read, mutation, request } = fixture();
    vi.mocked(read.getTreeEntries).mockResolvedValue([onlyEntry]);
    await expect(applyArtifact(read, mutation, request())).rejects.toThrow();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("rejects a non-directory ancestor", async () => {
    const { artifact, read, mutation, request } = fixture();
    artifact.operations = [
      { path: "link/child", operation: "add", mode: "100644", content: "eA==" },
    ];
    vi.mocked(read.getTreeEntries).mockResolvedValue([
      { path: "link", mode: "120000", type: "blob" },
    ]);
    await expect(applyArtifact(read, mutation, request())).rejects.toThrow(
      "non-directory",
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("rejects symlink and gitlink source entries", async () => {
    const { artifact, read, mutation, request } = fixture();
    artifact.operations = [
      { path: "link", operation: "modify", mode: "100644", content: "eA==" },
    ];
    vi.mocked(read.getTreeEntries).mockResolvedValue([
      { path: "link", mode: "120000", type: "blob" },
    ]);
    await expect(applyArtifact(read, mutation, request())).rejects.toThrow(
      "not an existing regular file",
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();

    artifact.operations = [
      { path: "module", operation: "delete", mode: "100644" },
    ];
    vi.mocked(read.getTreeEntries).mockResolvedValue([
      { path: "module", mode: "160000", type: "commit" },
    ]);
    await expect(applyArtifact(read, mutation, request())).rejects.toThrow(
      "not an existing regular file",
    );
  });

  it("rejects a fork that disallows maintainer edits", async () => {
    const { read, mutation, request } = fixture();
    vi.mocked(read.getMaintainerCanModify).mockResolvedValue(false);
    await expect(
      applyArtifact(read, mutation, request()),
    ).rejects.toMatchObject({
      outcome: { kind: "fork-edits-disabled" },
    });
    expect(read.getMaintainerCanModify).toHaveBeenCalledExactlyOnceWith(4);
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it.each([409, 422])(
    "attempts the ref update exactly once for status %i",
    async (status) => {
      const { read, mutation, request } = fixture();
      vi.mocked(mutation.updateRef).mockRejectedValue({
        status,
        message: "PAT=secret",
      });
      await expect(
        applyArtifact(read, mutation, request()),
      ).rejects.toMatchObject({
        outcome: {
          kind: "mutation-rejected",
          status,
          usedGithubTokenFallback: false,
        },
      });
      expect(mutation.updateRef).toHaveBeenCalledTimes(1);
    },
  );
});
