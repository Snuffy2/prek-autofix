import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  FixesFoundError,
  HardFailureError,
  NonConvergenceError,
  executeCommand,
  runCollect,
  sanitizedEnvironment,
  streamUntrustedOutput,
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
    {
      extraArgs: "--all-files",
      workingDirectory: ".",
      maxPasses,
      maxLogBytes: 1048576,
      passTimeoutSeconds: 600,
    },
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
      "[prek] ::set-output name=x::bad\n[prek] next\n",
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
      "[prek] first\r\n[prek] second\r[prek] ::warning::bad\n",
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

  it("caps each stream exactly and emits one safe truncation notice", () => {
    const source = { pause: vi.fn(), resume: vi.fn() };
    const chunks: string[] = [];
    const target = new EventEmitter() as EventEmitter & {
      write(chunk: string): boolean;
    };
    target.write = (chunk: string) => {
      chunks.push(chunk);
      return true;
    };
    const stream = streamUntrustedOutput(source, target, 5);

    stream.write(Buffer.from("123"));
    stream.write(Buffer.from("456"));
    stream.write(Buffer.from("ignored"));
    stream.end();

    expect(chunks.join("")).toBe(
      "[prek] 12345\n[prek] output truncated after 5 bytes\n",
    );
  });

  it("pauses the child stream until a backpressured destination drains", () => {
    const source = { pause: vi.fn(), resume: vi.fn() };
    const target = new EventEmitter() as EventEmitter & {
      write(chunk: string): boolean;
    };
    target.write = vi.fn(() => false);
    const stream = streamUntrustedOutput(source, target, 1024);

    stream.write(Buffer.from("blocked"));
    stream.write(Buffer.from("still blocked"));
    expect(source.pause).toHaveBeenCalledOnce();
    expect(source.resume).not.toHaveBeenCalled();

    target.emit("drain");
    expect(source.resume).toHaveBeenCalledOnce();
  });

  it("times out a hook and reports process-tree termination", async () => {
    await expect(
      executeCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 25,
        },
      ),
    ).rejects.toThrow(
      `prek pass timed out after 1 seconds; terminated hook process${
        process.platform === "linux" ? " tree" : ""
      }`,
    );
  });

  it.skipIf(process.platform !== "linux")(
    "terminates descendants in the timed-out hook process group",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "collect-tree-"));
      directories.push(directory);
      const pidFile = join(directory, "descendant.pid");
      const command = [
        'const {spawn}=require("node:child_process")',
        'const {writeFileSync}=require("node:fs")',
        `const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"])`,
        `writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
        "setInterval(()=>{},1000)",
      ].join(";");

      await expect(
        executeCommand(process.execPath, ["-e", command], {
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 100,
        }),
      ).rejects.toThrow("terminated hook process tree");

      const descendantPid = Number(await readFile(pidFile, "utf8"));
      let alive = true;
      for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          alive = false;
        }
      }
      expect(alive).toBe(false);
    },
  );
});
