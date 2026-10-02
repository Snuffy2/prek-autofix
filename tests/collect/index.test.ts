import { afterEach, describe, expect, it, vi } from "vitest";
import { runCollect } from "../../packages/collect/src/runner";

vi.mock("../../packages/collect/src/runner", () => ({
  runCollect: vi.fn().mockResolvedValue(undefined),
  executeCommand: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: vi.fn((name: string) =>
    name === "ignore-authors" ? "custom-bot[bot]" : "",
  ),
  info: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    eventName: "pull_request",
    runId: 42,
    runAttempt: 1,
    repo: { owner: "owner", repo: "repo" },
    workflow: "prek-autofix",
    payload: {
      pull_request: {
        number: 7,
        user: { login: "renovate[bot]" },
        head: { sha: "a".repeat(40) },
      },
      sender: { login: "maintainer" },
    },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("collection author configuration", () => {
  it.each([
    [undefined, "custom-bot[bot]"],
    ["dependabot[bot],renovate[bot]", "dependabot[bot],renovate[bot]"],
    ["", ""],
  ])(
    "passes the PR author and preserves the configured list %j",
    async (env, expected) => {
      vi.resetModules();
      vi.stubEnv("PREK_AUTOFIX_IGNORE_AUTHORS", env);
      await import("../../packages/collect/src/index.js");

      expect(runCollect).toHaveBeenCalledWith(
        expect.objectContaining({ pullRequestAuthor: "renovate[bot]" }),
        expect.objectContaining({ ignoreAuthors: expected }),
        expect.any(Object),
      );
    },
  );
});
