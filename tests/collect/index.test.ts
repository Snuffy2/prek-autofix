import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { versionBanner } from "../../packages/shared/src/version";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  runCollect: vi.fn().mockImplementation(async () => {
    mocks.events.push("collect");
  }),
}));

vi.mock("@actions/core", () => ({
  getInput: vi.fn().mockReturnValue(""),
  info: vi.fn((message: string) => mocks.events.push(`info:${message}`)),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    eventName: "pull_request",
    payload: {
      pull_request: {
        number: 7,
        head: { sha: "a".repeat(40) },
      },
    },
    repo: { owner: "owner", repo: "repo" },
    runAttempt: 1,
    runId: 42,
    workflow: "prek-autofix",
  },
}));

vi.mock("../../packages/collect/src/runner", () => ({
  executeCommand: vi.fn(),
  runCollect: mocks.runCollect,
}));

describe("collect entrypoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.events.length = 0;
  });

  it("logs the prek-autofix version before collecting", async () => {
    await import("../../packages/collect/src/index.js");

    await vi.waitFor(() => expect(mocks.runCollect).toHaveBeenCalledOnce());
    expect(core.info).toHaveBeenCalledWith(versionBanner());
    expect(mocks.events[0]).toBe(`info:${versionBanner()}`);
    expect(mocks.events.indexOf(`info:${versionBanner()}`)).toBeLessThan(
      mocks.events.indexOf("collect"),
    );
  });
});
