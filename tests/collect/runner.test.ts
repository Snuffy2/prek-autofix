import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FixesFoundError,
  HardFailureError,
  NonConvergenceError,
  executeCommand,
  runCollect,
  sanitizedEnvironment,
} from "../../packages/collect/src/runner";
import type { Execute } from "../../packages/collect/src/git";

const SHA = "a".repeat(40);
const directories: string[] = [];

function result(exitCode = 0, stdout = "") {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function setup(prekResults: ReturnType<typeof result>[]) {
  let prek = 0;
  const execute: Execute = vi.fn(async (command, args, options) => {
    expect(options.env.PREK_AUTOFIX_TOKEN).toBeUndefined();
    if (command === "prek") return prekResults[prek++] ?? result();
    if (args[0] === "rev-parse") return result(0, `${SHA}\n`);
    if (args[0] === "status") return result();
    if (args[0] === "ls-tree") return result();
    if (args[0] === "diff" || args[0] === "ls-files") return result();
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
  return execute;
}

async function invoke(
  execute: Execute,
  maxPasses = 3,
  initialStatus = false,
  changes: string[][] = [[]],
) {
  const workspace = await mkdtemp(join(tmpdir(), "collect-runner-"));
  directories.push(workspace);
  const wrapped: Execute = initialStatus
    ? async (command, args, options) =>
        args[0] === "status"
          ? result(0, " M dirty\0")
          : execute(command, args, options)
    : execute;
  const uploadArtifact = vi.fn(async () => ({
    id: 1,
    size: 10,
    digest: "digest",
  }));
  const outputs = new Map<string, string>();
  let inspection = 0;
  const promise = runCollect(
    {
      eventName: "pull_request",
      runId: 42,
      repository: "owner/repo",
      workflow: "prek-autofix",
      pullRequestNumber: 7,
      headSha: SHA,
      workspace,
      artifactDirectory: workspace,
    },
    { extraArgs: "--all-files", workingDirectory: ".", maxPasses },
    {
      execute: wrapped,
      artifact: { uploadArtifact },
      env: { PATH: process.env.PATH, PREK_AUTOFIX_TOKEN: "do-not-leak" },
      setOutput: (name, value) => outputs.set(name, value),
      collectChanges: async () =>
        (changes[inspection++] ?? []).map((path) => ({
          path,
          operation: "modify" as const,
          mode: "100644",
          content: Buffer.from(path).toString("base64"),
        })),
    },
  );
  return { promise, uploadArtifact, outputs, workspace };
}

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("runCollect", () => {
  it("passes a clean result without an artifact", async () => {
    const execute = setup([result(0)]);
    const call = await invoke(execute);
    await expect(call.promise).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      "prek",
      expect.anything(),
      expect.objectContaining({ streamUntrustedOutput: true }),
    );
    expect(call.outputs.get("changed")).toBe("false");
    expect(call.uploadArtifact).not.toHaveBeenCalled();
  });

  it("rejects an initially dirty checkout before running prek", async () => {
    const execute = setup([result(0)]);
    const call = await invoke(execute, 3, true);
    await expect(call.promise).rejects.toThrow("initial checkout is not clean");
    expect(execute).not.toHaveBeenCalledWith(
      "prek",
      expect.anything(),
      expect.anything(),
    );
  });

  it("distinguishes a clean hard failure", async () => {
    const call = await invoke(setup([result(2)]));
    await expect(call.promise).rejects.toBeInstanceOf(HardFailureError);
    expect(call.uploadArtifact).not.toHaveBeenCalled();
  });

  it("uploads stable fixes even when prek still reports a hard failure", async () => {
    const call = await invoke(
      setup([result(1), result(1)]),
      3,
      false,
      [["a"], ["a"]],
    );
    await expect(call.promise).rejects.toBeInstanceOf(HardFailureError);
    expect(call.uploadArtifact).toHaveBeenCalledOnce();
  });

  it("reports nonconvergence when every pass changes the tree", async () => {
    const execute = setup([result(1), result(1)]);
    const call = await invoke(execute, 2, false, [["a"], ["b"]]);
    await expect(call.promise).rejects.toBeInstanceOf(NonConvergenceError);
    expect(call.uploadArtifact).not.toHaveBeenCalled();
    expect(call.outputs.get("artifact-name")).toBe("");
  });

  it("uploads converged fixes and deliberately fails the check", async () => {
    const execute = setup([result(1), result(0)]);
    const call = await invoke(execute, 3, false, [["a"], ["a"]]);
    await expect(call.promise).rejects.toBeInstanceOf(FixesFoundError);
    expect(call.outputs).toEqual(
      new Map([
        ["changed", "true"],
        ["artifact-name", "prek-autofix-42"],
      ]),
    );
    expect(call.uploadArtifact).toHaveBeenCalledOnce();
    const artifact = JSON.parse(
      await readFile(join(call.workspace, "prek-autofix.json"), "utf8"),
    );
    expect(artifact.source).toMatchObject({
      runId: 42,
      pullRequestNumber: 7,
      headSha: SHA,
    });
    expect(JSON.stringify(artifact)).not.toContain("do-not-leak");
  });

  it("scrubs credential-like child environment variables", () => {
    expect(
      sanitizedEnvironment({
        PATH: "/bin",
        GITHUB_TOKEN: "token",
        CLIENT_SECRET: "secret",
        PASSWORD: "password",
        GITHUB_ENV: "/tmp/env",
        GITHUB_OUTPUT: "/tmp/output",
        GITHUB_PATH: "/tmp/path",
        GITHUB_STEP_SUMMARY: "/tmp/summary",
      }),
    ).toEqual({ PATH: "/bin" });
  });
});

describe("executeCommand", () => {
  it("streams chunked untrusted output with safe line prefixes", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const command = [
      'process.stdout.write(":")',
      'setTimeout(() => process.stdout.write(":set-output name=x::bad\\nnext"), 10)',
    ].join(";");

    const response = await executeCommand(process.execPath, ["-e", command], {
      cwd: process.cwd(),
      env: process.env,
      streamUntrustedOutput: true,
    });

    expect(response.stdout).toEqual(Buffer.alloc(0));
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(
      "[prek] ::set-output name=x::bad\n[prek] next",
    );
  });

  it("prefixes lone CR boundaries without double-prefixing split CRLF", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const command = [
      'process.stdout.write("first\\r")',
      'setTimeout(() => process.stdout.write("\\nsecond\\r"), 10)',
      'setTimeout(() => process.stdout.write("::warning::bad"), 20)',
    ].join(";");

    const response = await executeCommand(process.execPath, ["-e", command], {
      cwd: process.cwd(),
      env: process.env,
      streamUntrustedOutput: true,
    });

    expect(response.stdout).toEqual(Buffer.alloc(0));
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(
      "[prek] first\r\n[prek] second\r[prek] ::warning::bad",
    );
  });

  it("does not retain large streamed hook output", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const response = await executeCommand(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(1024 * 1024))'],
      {
        cwd: process.cwd(),
        env: process.env,
        streamUntrustedOutput: true,
      },
    );

    expect(response.stdout).toEqual(Buffer.alloc(0));
    expect(stdout).toHaveBeenCalled();
  });
});
