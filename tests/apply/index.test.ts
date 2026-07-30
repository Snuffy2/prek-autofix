import { ArtifactNotFoundError } from "@actions/artifact";
import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getArtifactIfPresent } from "../../packages/apply/src/artifact-lookup";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
}));

describe("apply artifact lookup", () => {
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
      getArtifactIfPresent(client, 7, "base", "repo", "token"),
    ).resolves.toBeUndefined();
    expect(core.info).toHaveBeenCalledWith(
      "No prek-autofix-7 artifact was produced; nothing to apply.",
    );
  });

  it("also recognizes the artifact library error name across module copies", async () => {
    const error = new Error("artifact is absent");
    error.name = "ArtifactNotFoundError";
    const client = {
      getArtifact: vi.fn().mockRejectedValue(error),
    };

    await expect(
      getArtifactIfPresent(client, 7, "base", "repo", "token"),
    ).resolves.toBeUndefined();
  });

  it("rethrows errors other than artifact not found", async () => {
    const error = new Error("API unavailable");
    const client = {
      getArtifact: vi.fn().mockRejectedValue(error),
    };

    await expect(
      getArtifactIfPresent(client, 7, "base", "repo", "token"),
    ).rejects.toBe(error);
    expect(core.info).not.toHaveBeenCalled();
  });

  it("returns an existing artifact and preserves its lookup contract", async () => {
    const lookup = {
      artifact: {
        id: 42,
        name: "prek-autofix-7",
        size: 100,
        digest: "sha256:digest",
        createdAt: new Date(),
      },
    };
    const client = {
      getArtifact: vi.fn().mockResolvedValue(lookup),
    };

    await expect(
      getArtifactIfPresent(client, 7, "base", "repo", "token"),
    ).resolves.toBe(lookup);
    expect(client.getArtifact).toHaveBeenCalledWith("prek-autofix-7", {
      findBy: {
        token: "token",
        workflowRunId: 7,
        repositoryOwner: "base",
        repositoryName: "repo",
      },
    });
  });
});
