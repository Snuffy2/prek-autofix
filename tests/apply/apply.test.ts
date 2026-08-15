import { describe, expect, it, vi } from "vitest";
import type { ChangeArtifact } from "../../packages/shared/src/artifact";
import {
  ApplyError,
  applyArtifact,
  maximumRawArtifactBytes,
  resolveSourcePullRequest,
  type MutationClient,
  type ReadClient,
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
  const read: ReadClient = {
    getWorkflowRun: vi.fn().mockResolvedValue({
      id: 7,
      name: "prek-autofix",
      event: "pull_request",
      headSha: "a".repeat(40),
      headBranch: "feature",
      headRepository: "user/repo",
    }),
    listAssociatedPullRequests: vi.fn().mockResolvedValue([
      {
        number: 4,
        state: "open",
        baseRepository: "base/repo",
        headRepository: "user/repo",
        headRepositoryNodeId: "R_head",
        headRepositoryOwnerType: "User",
        headRef: "feature",
        headSha: "a".repeat(40),
      },
    ]),
    getMaintainerCanModify: vi.fn().mockResolvedValue(true),
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
    createBlob: vi
      .fn()
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
  runAttempt: 2,
  artifact,
  sourceRunUrl: "https://example/run",
  sourceWorkflow: "prek-autofix",
  commitMessage: "fix",
  mutationTokenUsedGithubFallback: false,
});

describe("applyArtifact", () => {
  it("revalidates a source resolved before artifact and token processing", async () => {
    const { artifact, read, mutation } = fixture();
    const source = await resolveSourcePullRequest(read, {
      baseRepository: "base/repo",
      runId: 7,
      sourceWorkflow: "prek-autofix",
    });
    vi.mocked(read.getWorkflowRun).mockClear();
    vi.mocked(read.listAssociatedPullRequests).mockClear();

    await expect(
      applyArtifact(read, mutation, { ...request(artifact), source }),
    ).resolves.toEqual({ pullRequestNumber: 4, commitSha: "commit" });
    expect(read.getWorkflowRun).toHaveBeenCalledExactlyOnceWith(7);
    expect(read.listAssociatedPullRequests).toHaveBeenCalledExactlyOnceWith(
      "a".repeat(40),
    );
  });

  it("rejects empty artifacts and unsafe raw-size arithmetic", async () => {
    const { artifact, read, mutation } = fixture();
    artifact.operations = [];
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("no file operations");
    expect(read.getWorkflowRun).not.toHaveBeenCalled();
    expect(() => maximumRawArtifactBytes(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      "too large",
    );
  });

  it("creates blobs, one tree, one commit, and a non-forced ref update boundary", async () => {
    const { artifact, read, mutation } = fixture();
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).resolves.toEqual({
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

  it.each([
    ["runId", 8],
    ["runAttempt", 3],
    ["repository", "evil/repo"],
    ["workflow", "evil"],
    ["pullRequestNumber", 99],
    ["headSha", "b".repeat(40)],
  ] as const)("rejects a forged %s claim", async (field, value) => {
    const { artifact, read, mutation } = fixture();
    Object.assign(artifact.source, { [field]: value });
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("artifact source claims");
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
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("not eligible");
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
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("exactly one");
    expect(read.getMaintainerCanModify).not.toHaveBeenCalled();
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
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("exactly one");
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("treats a duplicate run after a successful update as obsolete", async () => {
    const { artifact, read, mutation } = fixture();
    const baseline = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      {
        ...baseline,
        headSha: "b".repeat(40),
        headRepositoryOwnerType: "Organization",
      },
    ]);
    await expect(
      applyArtifact(read, mutation, {
        ...request(artifact),
        mutationTokenUsedGithubFallback: true,
      }),
    ).rejects.toThrow("head changed");
    expect(read.markCommentObsolete).toHaveBeenCalledWith(4);
    expect(read.upsertComment).not.toHaveBeenCalled();
    expect(read.getMaintainerCanModify).not.toHaveBeenCalled();
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("rejects a missing head repository node identity", async () => {
    const { artifact, read, mutation } = fixture();
    const baseline = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...baseline, headRepositoryNodeId: "" },
    ]);
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("identity is missing");
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("allows a same-repository PR without the maintainer flag", async () => {
    const { artifact, read, mutation } = fixture();
    const run = await read.getWorkflowRun(7);
    vi.mocked(read.getWorkflowRun).mockResolvedValue({
      ...run,
      headRepository: "base/repo",
    });
    const pr = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      {
        ...pr,
        headRepository: "base/repo",
      },
    ]);
    await expect(
      applyArtifact(read, mutation, {
        ...request(artifact),
        mutationTokenUsedGithubFallback: true,
      }),
    ).resolves.toBeDefined();
    expect(read.getMaintainerCanModify).not.toHaveBeenCalled();
  });

  it("does not update a pull request that closes after initial validation", async () => {
    const { artifact, read, mutation } = fixture();
    const source = await resolveSourcePullRequest(read, {
      baseRepository: "base/repo",
      runId: 7,
      sourceWorkflow: "prek-autofix",
    });
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...source.pullRequest, state: "closed" },
    ]);

    await expect(
      applyArtifact(read, mutation, { ...request(artifact), source }),
    ).rejects.toThrow("no longer eligible");
    expect(mutation.createCommit).toHaveBeenCalledOnce();
    expect(mutation.updateRef).not.toHaveBeenCalled();
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining("no longer eligible"),
    );
  });

  it("treats a head change during final revalidation as obsolete", async () => {
    const { artifact, read, mutation } = fixture();
    const source = await resolveSourcePullRequest(read, {
      baseRepository: "base/repo",
      runId: 7,
      sourceWorkflow: "prek-autofix",
    });
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...source.pullRequest, headSha: "b".repeat(40) },
    ]);

    await expect(
      applyArtifact(read, mutation, { ...request(artifact), source }),
    ).rejects.toThrow("the pull request head changed after collection");
    expect(read.markCommentObsolete).toHaveBeenCalledWith(4);
    expect(read.upsertComment).not.toHaveBeenCalled();
    expect(mutation.updateRef).not.toHaveBeenCalled();
  });

  it("revalidates that a fork remains user-owned", async () => {
    const { artifact, read, mutation } = fixture();
    const source = await resolveSourcePullRequest(read, {
      baseRepository: "base/repo",
      runId: 7,
      sourceWorkflow: "prek-autofix",
    });
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      { ...source.pullRequest, headRepositoryOwnerType: "Organization" },
    ]);

    await expect(
      applyArtifact(read, mutation, { ...request(artifact), source }),
    ).rejects.toThrow("source changed before autofix");
    expect(mutation.updateRef).not.toHaveBeenCalled();
  });

  it("does not update a fork after maintainer edits are revoked", async () => {
    const { artifact, read, mutation } = fixture();
    vi.mocked(read.getMaintainerCanModify)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("no longer allows maintainer edits");
    expect(read.getMaintainerCanModify).toHaveBeenCalledTimes(2);
    expect(mutation.createCommit).toHaveBeenCalledOnce();
    expect(mutation.updateRef).not.toHaveBeenCalled();
  });

  it("rejects the built-in token for a cross-repository update", async () => {
    const { artifact, read, mutation } = fixture();
    await expect(
      applyArtifact(read, mutation, {
        ...request(artifact),
        mutationTokenUsedGithubFallback: true,
      }),
    ).rejects.toThrow(
      "Cannot apply fixes to this fork because the GitHub PAT token PREK_AUTOFIX_TOKEN is not configured",
    );
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining(
        "[See instructions here](https://github.com/Snuffy2/prek-autofix#1-create-the-cross-repository-token-when-needed)",
      ),
    );
    expect(read.getMaintainerCanModify).not.toHaveBeenCalled();
    expect(mutation.createBlob).not.toHaveBeenCalled();
    expect(mutation.createTree).not.toHaveBeenCalled();
    expect(mutation.createCommit).not.toHaveBeenCalled();
    expect(mutation.updateRef).not.toHaveBeenCalled();
  });

  it("rejects organization-owned forks with a persistent comment", async () => {
    const { artifact, read, mutation } = fixture();
    const pr = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      {
        ...pr,
        headRepositoryOwnerType: "Organization",
      },
    ]);
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("user-owned");
    expect(read.upsertComment).toHaveBeenCalledOnce();
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
    const { artifact, read, mutation } = fixture();
    vi.mocked(read.getTreeEntries).mockResolvedValue([onlyEntry]);
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow();
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
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("non-directory");
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
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("not an existing regular file");
    expect(mutation.createBlob).not.toHaveBeenCalled();

    artifact.operations = [
      { path: "module", operation: "delete", mode: "100644" },
    ];
    vi.mocked(read.getTreeEntries).mockResolvedValue([
      { path: "module", mode: "160000", type: "commit" },
    ]);
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow("not an existing regular file");
  });

  it("comments once through the read client when an eligible fork cannot be updated", async () => {
    const { artifact, read, mutation } = fixture();
    vi.mocked(read.getMaintainerCanModify).mockResolvedValue(false);
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow(ApplyError);
    expect(read.getMaintainerCanModify).toHaveBeenCalledExactlyOnceWith(4);
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining("does not allow maintainer edits"),
    );
    expect(mutation.createBlob).not.toHaveBeenCalled();
  });

  it("treats a ref race as terminal and posts recovery instructions", async () => {
    const { artifact, read, mutation } = fixture();
    vi.mocked(mutation.updateRef).mockRejectedValue({ status: 422 });
    await expect(
      applyArtifact(read, mutation, request(artifact)),
    ).rejects.toThrow(
      "GitHub could not update the pull request branch because it changed or the update was not allowed",
    );
    expect(mutation.updateRef).toHaveBeenCalledTimes(1);
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining("Inspect the source run"),
    );
  });

  it.each([409, 422])(
    "attempts the ref update exactly once for status %i",
    async (status) => {
      const { artifact, read, mutation } = fixture();
      vi.mocked(mutation.updateRef).mockRejectedValue({
        status,
        message: "PAT=secret",
      });
      await expect(
        applyArtifact(read, mutation, request(artifact)),
      ).rejects.not.toThrow("secret");
      expect(mutation.updateRef).toHaveBeenCalledTimes(1);
      expect(read.upsertComment).toHaveBeenCalledOnce();
    },
  );

  it("sanitizes a mutation failure and posts recovery", async () => {
    const { artifact, read, mutation } = fixture();
    vi.mocked(mutation.createBlob)
      .mockReset()
      .mockRejectedValue(new Error("remote said token ghp_secret"));
    const outcome = applyArtifact(read, mutation, request(artifact));
    await expect(outcome).rejects.toThrow("GitHub rejected the fix commit");
    expect(read.upsertComment).toHaveBeenCalled();
    expect(vi.mocked(read.upsertComment).mock.calls[0]?.[1]).not.toContain(
      "ghp_secret",
    );
  });

  it("explains a denied GITHUB_TOKEN fallback without exposing API details", async () => {
    const { artifact, read, mutation } = fixture();
    const run = await read.getWorkflowRun(7);
    vi.mocked(read.getWorkflowRun).mockResolvedValue({
      ...run,
      headRepository: "base/repo",
    });
    const pullRequest = (await read.listAssociatedPullRequests("x"))[0]!;
    vi.mocked(read.listAssociatedPullRequests).mockResolvedValue([
      {
        ...pullRequest,
        baseRepository: "base/repo",
        headRepository: "base/repo",
      },
    ]);
    vi.mocked(mutation.createBlob).mockReset().mockRejectedValue({
      status: 403,
      message: "remote included ghp_do_not_leak",
    });

    await expect(
      applyArtifact(read, mutation, {
        ...request(artifact),
        mutationTokenUsedGithubFallback: true,
      }),
    ).rejects.toThrow("GITHUB_TOKEN could not update");
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining("grant contents: write"),
    );
    expect(vi.mocked(read.upsertComment).mock.calls[0]?.[1]).not.toContain(
      "ghp_do_not_leak",
    );
  });
});
