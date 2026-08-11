import { ArtifactNotFoundError } from "@actions/artifact";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getArtifactIfPresent } from "../../packages/apply/src/artifact-lookup";

const mocks = vi.hoisted(() => ({
  applyArtifact: vi.fn(),
  artifactClient: vi.fn(),
  readFile: vi.fn(),
  setFailed: vi.fn(),
  stat: vi.fn(),
  verifySourceJobs: vi.fn(),
  context: {
    eventName: "workflow_run",
    payload: {
      workflow_run: {
        id: 7,
        run_attempt: 3 as number | undefined,
      },
    },
    repo: {
      owner: "base",
      repo: "repo",
    },
    serverUrl: "https://github.example",
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  stat: mocks.stat,
}));

vi.mock("../../packages/apply/src/apply", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../packages/apply/src/apply")>();
  return { ...actual, applyArtifact: mocks.applyArtifact };
});

vi.mock("@actions/artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/artifact")>();
  return {
    ...actual,
    DefaultArtifactClient: mocks.artifactClient,
  };
});

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  setFailed: mocks.setFailed,
  setSecret: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: mocks.context,
  getOctokit: vi.fn(),
}));

vi.mock("../../packages/apply/src/source-jobs", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../packages/apply/src/source-jobs")
    >();
  return {
    ...actual,
    verifySourceJobs: mocks.verifySourceJobs,
  };
});

describe("apply entrypoint validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.context.eventName = "workflow_run";
    mocks.context.payload.workflow_run = {
      id: 7,
      run_attempt: 3,
    };
    vi.mocked(core.getInput).mockReturnValue("");
    mocks.applyArtifact.mockResolvedValue({
      pullRequestNumber: 4,
      commitSha: "commit",
    });
  });

  it.each([
    {
      name: "a non-workflow_run event",
      eventName: "pull_request",
      runAttempt: 3,
      message: "fix action may only run for workflow_run",
    },
    {
      name: "a missing workflow run attempt",
      eventName: "workflow_run",
      runAttempt: undefined,
      message: "workflow_run.run_attempt is required",
    },
    {
      name: "a zero workflow run attempt",
      eventName: "workflow_run",
      runAttempt: 0,
      message: "workflow_run.run_attempt is required",
    },
    {
      name: "a fractional workflow run attempt",
      eventName: "workflow_run",
      runAttempt: 1.5,
      message: "workflow_run.run_attempt is required",
    },
  ])(
    "rejects $name before input access or artifact lookup",
    async ({ eventName, runAttempt, message }) => {
      mocks.context.eventName = eventName;
      mocks.context.payload.workflow_run.run_attempt = runAttempt;
      await import("../../packages/apply/src/index.js");

      await vi.waitFor(() => {
        expect(core.setFailed).toHaveBeenCalledWith(message);
      });
      expect(core.getInput).not.toHaveBeenCalled();
      expect(mocks.artifactClient).not.toHaveBeenCalled();
      expect(github.getOctokit).not.toHaveBeenCalled();
    },
  );

  it("uses the built-in token for read access and artifact retrieval", async () => {
    const githubToken = "built-in-token-sentinel";
    const readOctokit = { rest: {} };
    const artifactClient = {
      getArtifact: vi.fn().mockResolvedValue({
        artifact: {
          id: 42,
          name: "prek-autofix-7-3",
          size: 100,
          digest: "sha256:digest",
          createdAt: new Date(),
        },
      }),
      downloadArtifact: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(core.getInput).mockImplementation((name) =>
      name === "github-token" ? githubToken : "",
    );
    vi.mocked(github.getOctokit).mockReturnValue(readOctokit as never);
    mocks.artifactClient.mockImplementation(function ArtifactClient() {
      return artifactClient;
    });
    mocks.verifySourceJobs.mockResolvedValue(undefined);

    await import("../../packages/apply/src/index.js");

    await vi.waitFor(() => {
      expect(core.setFailed).toHaveBeenCalledWith(
        "artifact download path is missing",
      );
    });
    expect(core.getInput).toHaveBeenCalledWith("github-token", {
      required: true,
    });
    expect(core.setSecret).toHaveBeenCalledWith(githubToken);
    expect(github.getOctokit).toHaveBeenCalledWith(githubToken);
    expect(mocks.verifySourceJobs).toHaveBeenCalledWith(
      readOctokit,
      "base",
      "repo",
      7,
      3,
    );
    const findBy = {
      token: githubToken,
      workflowRunId: 7,
      repositoryOwner: "base",
      repositoryName: "repo",
    };
    expect(artifactClient.getArtifact).toHaveBeenCalledWith(
      "prek-autofix-7-3",
      { findBy },
    );
    expect(artifactClient.downloadArtifact).toHaveBeenCalledWith(42, {
      findBy,
    });
  });

  it.each([
    {
      name: "empty autofix input",
      autofixToken: "",
      expectedMutationToken: "github-token",
      expectedFallback: true,
    },
    {
      name: "configured autofix token",
      autofixToken: "configured-token",
      expectedMutationToken: "configured-token",
      expectedFallback: false,
    },
  ])(
    "parses the artifact and wires the mutation credential for $name",
    async ({ autofixToken, expectedMutationToken, expectedFallback }) => {
      const artifactClient = {
        getArtifact: vi.fn().mockResolvedValue({
          artifact: {
            id: 42,
            name: "prek-autofix-7-3",
            size: 100,
            digest: "sha256:digest",
            createdAt: new Date(),
          },
        }),
        downloadArtifact: vi.fn().mockResolvedValue({
          downloadPath: "/artifact",
        }),
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
          headSha: "a".repeat(40),
        },
        operations: [
          {
            path: "fixed.txt",
            operation: "add",
            mode: "100644",
            content: "eA==",
          },
        ],
      };
      vi.mocked(core.getInput).mockImplementation((name) => {
        if (name === "github-token") return "github-token";
        if (name === "autofix-token") return autofixToken;
        return "";
      });
      vi.mocked(github.getOctokit).mockReturnValue({ rest: {} } as never);
      mocks.artifactClient.mockImplementation(function ArtifactClient() {
        return artifactClient;
      });
      mocks.verifySourceJobs.mockResolvedValue(undefined);
      mocks.stat.mockResolvedValue({ size: 100 });
      mocks.readFile.mockResolvedValue(JSON.stringify(artifact));

      await import("../../packages/apply/src/index.js");

      await vi.waitFor(() =>
        expect(mocks.applyArtifact).toHaveBeenCalledOnce(),
      );
      expect(core.getInput).toHaveBeenCalledWith("autofix-token");
      expect(github.getOctokit).toHaveBeenCalledWith("github-token");
      expect(github.getOctokit).toHaveBeenCalledWith(expectedMutationToken);
      expect(mocks.applyArtifact).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          artifact,
          mutationTokenUsedGithubFallback: expectedFallback,
        }),
      );
      expect(core.setFailed).not.toHaveBeenCalled();
    },
  );
});

describe("apply artifact lookup behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns successfully when the collector artifact is missing", async () => {
    const client = {
      getArtifact: vi
        .fn()
        .mockRejectedValue(new ArtifactNotFoundError("artifact is absent")),
    };

    await expect(
      getArtifactIfPresent(client, 7, 3, "base", "repo", "token"),
    ).resolves.toBeUndefined();
    expect(core.info).toHaveBeenCalledWith(
      "No prek-autofix-7-3 artifact was produced; nothing to apply.",
    );
  });

  it("also recognizes the artifact library error name across module copies", async () => {
    const error = new Error("artifact is absent");
    error.name = "ArtifactNotFoundError";
    const client = {
      getArtifact: vi.fn().mockRejectedValue(error),
    };

    await expect(
      getArtifactIfPresent(client, 7, 3, "base", "repo", "token"),
    ).resolves.toBeUndefined();
  });

  it("rethrows errors other than artifact not found", async () => {
    const error = new Error("API unavailable");
    const client = {
      getArtifact: vi.fn().mockRejectedValue(error),
    };

    await expect(
      getArtifactIfPresent(client, 7, 3, "base", "repo", "token"),
    ).rejects.toBe(error);
    expect(core.info).not.toHaveBeenCalled();
  });

  it("returns an existing artifact and preserves its lookup contract", async () => {
    const lookup = {
      artifact: {
        id: 42,
        name: "prek-autofix-7-3",
        size: 100,
        digest: "sha256:digest",
        createdAt: new Date(),
      },
    };
    const client = {
      getArtifact: vi.fn().mockResolvedValue(lookup),
    };

    await expect(
      getArtifactIfPresent(client, 7, 3, "base", "repo", "token"),
    ).resolves.toBe(lookup);
    expect(client.getArtifact).toHaveBeenCalledWith("prek-autofix-7-3", {
      findBy: {
        token: "token",
        workflowRunId: 7,
        repositoryOwner: "base",
        repositoryName: "repo",
      },
    });
  });
});
