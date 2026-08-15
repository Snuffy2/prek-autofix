import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApplyError,
  FORK_AUTOFIX_TOKEN_REQUIRED,
  SAFE_BRANCH_UPDATE_REJECTED,
  type ReadClient,
  type ResolvedSource,
  type StatusClient,
} from "../../packages/apply/src/apply";
import { createFixReporter } from "../../packages/apply/src/reporting";

function fixture() {
  const source: ResolvedSource = {
    run: {
      id: 7,
      name: "prek-autofix",
      event: "pull_request",
      headSha: "a".repeat(40),
      headBranch: "feature",
      headRepository: "fork/repo",
    },
    pullRequest: {
      number: 4,
      state: "open",
      baseRepository: "base/repo",
      headRepository: "fork/repo",
      headRepositoryNodeId: "R_fork",
      headRepositoryOwnerType: "User",
      headRef: "feature",
      headSha: "a".repeat(40),
    },
  };
  const read = {
    upsertComment: vi.fn(),
  } as unknown as ReadClient;
  const status: StatusClient = { setCommitStatus: vi.fn() };
  const reporter = createFixReporter(read, status, {
    source,
    fixRunUrl: "https://example/fix",
    sourceRunUrl: "https://example/source",
  });
  return { read, reporter, source, status };
}

describe("fix result reporting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes pending and successful statuses on the source head", async () => {
    const { reporter, source, status } = fixture();

    await reporter.pending();
    await reporter.success();

    expect(status.setCommitStatus).toHaveBeenNthCalledWith(
      1,
      source.run.headSha,
      "pending",
      "Applying generated prek fixes",
      "https://example/fix",
    );
    expect(status.setCommitStatus).toHaveBeenNthCalledWith(
      2,
      source.run.headSha,
      "success",
      "Generated prek fixes were applied",
      "https://example/fix",
    );
  });

  it("reports an empty autofix token with recovery guidance", async () => {
    const { read, reporter, source, status } = fixture();

    await reporter.failure(
      new Error("Input required and not supplied: autofix-token"),
    );

    expect(status.setCommitStatus).toHaveBeenCalledWith(
      source.run.headSha,
      "failure",
      "autofix-token resolved empty",
      "https://example/fix",
    );
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.stringMatching(
        /PREK_AUTOFIX_TOKEN.*Inspect the fix run.*inspect the source run/s,
      ),
    );
  });

  it("explains how to recover when a fork token is not configured", async () => {
    const { read, reporter, source, status } = fixture();

    await reporter.failure(new ApplyError(FORK_AUTOFIX_TOKEN_REQUIRED));

    expect(status.setCommitStatus).toHaveBeenCalledWith(
      source.run.headSha,
      "failure",
      "Cannot update fork: PREK_AUTOFIX_TOKEN is not configured",
      "https://example/fix",
    );
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining(
        "The repo owner needs add that token before autofix will work",
      ),
    );
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining(
        "[See instructions here](https://github.com/Snuffy2/prek-autofix#1-create-the-cross-repository-token-when-needed)",
      ),
    );
  });

  it("does not expose an unexpected exception in the pull request", async () => {
    const { read, reporter, status } = fixture();

    await reporter.failure(new Error("remote included ghp_do_not_leak"));

    expect(status.setCommitStatus).toHaveBeenCalledWith(
      expect.any(String),
      "failure",
      "Fix action failed unexpectedly",
      "https://example/fix",
    );
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.not.stringContaining("ghp_do_not_leak"),
    );
  });

  it("reports a stale source head without replacing the obsolete comment", async () => {
    const { read, reporter, source, status } = fixture();

    await reporter.failure(
      new ApplyError("the pull request head changed after collection"),
    );

    expect(status.setCommitStatus).toHaveBeenCalledWith(
      source.run.headSha,
      "failure",
      "Pull request head changed",
      "https://example/fix",
    );
    expect(read.upsertComment).not.toHaveBeenCalled();
  });

  it.each([
    "the pull request is no longer eligible for autofix",
    "the pull request source changed before autofix",
    "the fork no longer allows maintainer edits",
    SAFE_BRANCH_UPDATE_REJECTED,
  ])("reports the controlled apply failure: %s", async (message) => {
    const { read, reporter, source, status } = fixture();

    await reporter.failure(new ApplyError(message));

    expect(status.setCommitStatus).toHaveBeenCalledWith(
      source.run.headSha,
      "failure",
      message,
      "https://example/fix",
    );
    expect(read.upsertComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining(`**${message}.**`),
    );
  });

  it("keeps status and comment publication best effort", async () => {
    const { read, reporter, status } = fixture();
    vi.mocked(status.setCommitStatus).mockRejectedValue(
      new Error("status denied"),
    );
    vi.mocked(read.upsertComment).mockRejectedValue(
      new Error("comment denied"),
    );

    await expect(reporter.failure(new Error("boom"))).resolves.toBeUndefined();
  });
});
