import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
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
const seenEnvironments: NodeJS.ProcessEnv[] = [];

function result(exitCode = 0, stdout = "") {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

function setup(prekResults: ReturnType<typeof result>[]) {
  let prek = 0;
  const execute: Execute = vi.fn(async (command, args, options) => {
    seenEnvironments.push(options.env);
    if (command === "prek") return prekResults[prek++] ?? result();
    if (command.includes("python3")) return result();
    if (args[2] === "rev-parse") return result(0, `${SHA}\n`);
    if (args[2] === "status") return result();
    if (args[2] === "ls-tree") return result();
    if (args[2] === "diff" || args[2] === "ls-files") return result();
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
  return execute;
}

function expectSecretsExcluded(): void {
  expect(seenEnvironments.length).toBeGreaterThan(0);
  for (const environment of seenEnvironments) {
    expect(environment.PREK_AUTOFIX_TOKEN).toBeUndefined();
    expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(environment.API_KEY).toBeUndefined();
    expect(environment.PRIVATE_KEY).toBeUndefined();
    expect(environment.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(environment.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(environment.DOCKER_CONFIG).toBeUndefined();
    expect(environment.GIT_EXTERNAL_DIFF).toBeUndefined();
  }
}

async function invoke(
  execute: Execute,
  maxPasses = 3,
  initialStatus = false,
  changes: string[][] = [[]],
  platform: NodeJS.Platform = "linux",
) {
  const workspace = await mkdtemp(join(tmpdir(), "collect-runner-"));
  directories.push(workspace);
  const wrapped: Execute = initialStatus
    ? async (command, args, options) =>
        args[2] === "status"
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
  const collectChanges = vi.fn(async () =>
    (changes[inspection++] ?? []).map((path) => ({
      path,
      operation: "modify" as const,
      mode: "100644",
      content: Buffer.from(path).toString("base64"),
    })),
  );
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
      env: {
        PATH: process.env.PATH,
        PREK_AUTOFIX_TOKEN: "do-not-leak",
        AWS_ACCESS_KEY_ID: "access-key",
        API_KEY: "api-key",
        PRIVATE_KEY: "private-key",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/credentials",
        NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
        DOCKER_CONFIG: "/tmp/docker",
        GIT_EXTERNAL_DIFF: "/tmp/diff",
      },
      platform,
      setOutput: (name, value) => outputs.set(name, value),
      collectChanges,
    },
  );
  return { promise, uploadArtifact, outputs, workspace, collectChanges };
}

afterEach(async () => {
  vi.restoreAllMocks();
  seenEnvironments.length = 0;
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("runCollect", () => {
  it("fails closed on unsupported runner platforms", async () => {
    const execute = setup([result(0)]);
    const call = await invoke(execute, 3, false, [[]], "darwin");

    await expect(call.promise).rejects.toThrow(
      "secure collection requires a Linux runner",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes a clean result without an artifact", async () => {
    const execute = setup([result(0)]);
    const call = await invoke(execute);
    await expect(call.promise).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      "prek",
      expect.anything(),
      expect.objectContaining({
        superviseProcessTree: true,
        streamUntrustedOutput: true,
      }),
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
    expectSecretsExcluded();
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
    expectSecretsExcluded();
    expect(call.uploadArtifact).toHaveBeenCalledOnce();
  });

  it("reports nonconvergence when every pass changes the tree", async () => {
    const execute = setup([result(1), result(1)]);
    const call = await invoke(execute, 2, false, [["a"], ["b"]]);
    await expect(call.promise).rejects.toBeInstanceOf(NonConvergenceError);
    expectSecretsExcluded();
    expect(call.uploadArtifact).not.toHaveBeenCalled();
    expect(call.outputs.get("artifact-name")).toBe("");
  });

  it("requires a successful fix snapshot to stabilize", async () => {
    const call = await invoke(
      setup([result(0), result(0)]),
      3,
      false,
      [["a"], ["a"]],
    );

    await expect(call.promise).resolves.toBeUndefined();
    expect(call.collectChanges).toHaveBeenCalledTimes(2);
    expect(call.uploadArtifact).toHaveBeenCalledOnce();
  });

  it("rejects ever-changing successful fix snapshots", async () => {
    const call = await invoke(
      setup([result(0), result(0)]),
      2,
      false,
      [["a"], ["b"]],
    );

    await expect(call.promise).rejects.toBeInstanceOf(NonConvergenceError);
    expect(call.collectChanges).toHaveBeenCalledTimes(2);
    expect(call.uploadArtifact).not.toHaveBeenCalled();
    expect(call.outputs.get("artifact-name")).toBe("");
  });

  it("stops before change collection when a hook changes HEAD", async () => {
    let headChecks = 0;
    const execute: Execute = vi.fn(async (command, args) => {
      if (command.includes("python3")) return result();
      if (command === "prek") return result();
      if (args[2] === "rev-parse") {
        headChecks += 1;
        return result(0, `${headChecks === 1 ? SHA : "b".repeat(40)}\n`);
      }
      if (args[2] === "status") return result();
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });
    const call = await invoke(execute, 3, false, [[]]);
    await expect(call.promise).rejects.toThrow(
      "checkout HEAD does not match pull request head SHA",
    );
    expect(call.collectChanges).not.toHaveBeenCalled();
    expect(call.uploadArtifact).not.toHaveBeenCalled();
  });

  it("stops when the workspace pathname is substituted after a hook", async () => {
    let substituted = false;
    const execute: Execute = vi.fn(async (command, args, options) => {
      if (command.includes("python3")) return result();
      if (command === "prek") {
        const parked = `${options.cwd}-parked`;
        directories.push(parked);
        const { mkdir, rename } = await import("node:fs/promises");
        await rename(options.cwd, parked);
        await mkdir(options.cwd);
        substituted = true;
        return result();
      }
      if (args[2] === "rev-parse") return result(0, `${SHA}\n`);
      if (args[2] === "status") return result();
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });
    const call = await invoke(execute);

    await expect(call.promise).rejects.toThrow(
      "workspace identity changed while hooks were running",
    );
    expect(substituted).toBe(true);
    expect(call.uploadArtifact).not.toHaveBeenCalled();
  });

  it("uploads converged fixes and reports them through outputs", async () => {
    const execute = setup([result(1), result(0)]);
    const call = await invoke(execute, 3, false, [["a"], ["a"]]);
    await expect(call.promise).resolves.toBeUndefined();
    expect(call.outputs).toEqual(
      new Map([
        ["changed", "true"],
        ["artifact-name", "prek-autofix-42"],
      ]),
    );
    expect(call.uploadArtifact).toHaveBeenCalledOnce();
    const uploadCall = call.uploadArtifact.mock.calls[0] as
      | [string, string[]]
      | undefined;
    const uploadedFile = uploadCall?.[1][0];
    expect(uploadedFile).toBeDefined();
    const artifact = JSON.parse(
      await readFile(uploadedFile!, "utf8"),
    );
    expect(artifact.source).toMatchObject({
      runId: 42,
      pullRequestNumber: 7,
      headSha: SHA,
    });
    expect(JSON.stringify(artifact)).not.toContain("do-not-leak");
  });

  it("allows only required hook runtime and cache environment variables", () => {
    expect(
      sanitizedEnvironment({
        PATH: "/bin",
        HOME: "/home/runner",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        CI: "true",
        GITHUB_WORKSPACE: "/workspace",
        GITHUB_REPOSITORY: "owner/repo",
        RUNNER_TEMP: "/runner-temp",
        PREK_HOME: "/cache/prek",
        PRE_COMMIT_HOME: "/cache/pre-commit",
        XDG_CACHE_HOME: "/cache",
        GITHUB_TOKEN: "token",
        GH_TOKEN: "token",
        ACTIONS_RUNTIME_TOKEN: "token",
        NODE_AUTH_TOKEN: "token",
        PREK_AUTOFIX_TOKEN: "token",
        CLIENT_SECRET: "secret",
        PASSWORD: "password",
        AWS_ACCESS_KEY_ID: "access-key",
        API_KEY: "api-key",
        PRIVATE_KEY: "private-key",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/credentials",
        NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
        DOCKER_CONFIG: "/tmp/docker",
        GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
        GIT_EXTERNAL_DIFF: "/tmp/diff",
        GITHUB_ENV: "/tmp/env",
        GITHUB_OUTPUT: "/tmp/output",
        GITHUB_PATH: "/tmp/path",
        GITHUB_STEP_SUMMARY: "/tmp/summary",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/runner",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      CI: "true",
      GITHUB_WORKSPACE: "/workspace",
      GITHUB_REPOSITORY: "owner/repo",
      RUNNER_TEMP: "/runner-temp",
      PREK_HOME: "/cache/prek",
      PRE_COMMIT_HOME: "/cache/pre-commit",
      XDG_CACHE_HOME: "/cache",
    });
  });
});

describe("executeCommand", () => {
  it("rejects captured command output above its ceiling", async () => {
    await expect(
      executeCommand(
        process.execPath,
        ["-e", 'process.stdout.write(Buffer.alloc(1025, "x"))'],
        {
          cwd: process.cwd(),
          env: process.env,
          captureLimitBytes: 1024,
        },
      ),
    ).rejects.toThrow("command output exceeded capture limit of 1024 bytes");
  });

  it("force-kills a capture-overflow command that ignores SIGTERM", async () => {
    const command = [
      'process.on("SIGTERM",()=>{})',
      'setInterval(()=>process.stdout.write(Buffer.alloc(2048,"x")),1)',
    ].join(";");

    await expect(
      executeCommand(process.execPath, ["-e", command], {
        cwd: process.cwd(),
        env: process.env,
        captureLimitBytes: 1024,
      }),
    ).rejects.toThrow("command output exceeded capture limit of 1024 bytes");
  });

  it("accepts captured command output exactly at its ceiling", async () => {
    const response = await executeCommand(
      process.execPath,
      ["-e", 'process.stdout.write(Buffer.alloc(1024, "x"))'],
      {
        cwd: process.cwd(),
        env: process.env,
        captureLimitBytes: 1024,
      },
    );

    expect(response.stdout).toHaveLength(1024);
  });

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
    "terminates descendants after a successful hook process",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "collect-tree-success-"));
      directories.push(directory);
      const descendantMutation = join(directory, "descendant-mutation");
      const command = [
        'const {spawn}=require("node:child_process")',
        `const child=spawn(process.execPath,["-e",${JSON.stringify(`setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(descendantMutation)},"escaped"),500);setInterval(()=>{},1000)`)}],{stdio:"ignore"})`,
        "child.unref()",
      ].join(";");

      await executeCommand(process.execPath, ["-e", command], {
        cwd: process.cwd(),
        env: process.env,
        superviseProcessTree: true,
        trustedPythonPath: "/usr/bin/python3",
        timeoutMs: 5000,
      });

      await new Promise((resolve) => setTimeout(resolve, 700));
      await expect(readFile(descendantMutation)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "prevents hooks from writing to the supervisor protocol descriptor",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "collect-protocol-isolation-"));
      directories.push(directory);
      const observation = join(directory, "protocol-observation");
      const script = `
import os
try:
    protocol = os.open("/proc/%d/fd/3" % os.getppid(), os.O_WRONLY)
except OSError:
    result = "blocked"
else:
    os.write(protocol, b"READY\\nNON_DUMPABLE\\nCLEAN normal\\n")
    os.close(protocol)
    result = "exposed"
with open(${JSON.stringify(observation)}, "w", encoding="ascii") as output:
    output.write(result)
`;

      const response = await executeCommand(
        "/usr/bin/python3",
        ["-I", "-c", script],
        {
          cwd: directory,
          env: { PATH: process.env.PATH },
          superviseProcessTree: true,
          trustedPythonPath: "/usr/bin/python3",
          timeoutMs: 5000,
        },
      );

      expect(response.exitCode).toBe(0);
      expect(await readFile(observation, "utf8")).toBe("blocked");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "terminates descendants in the timed-out hook process group",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "collect-tree-"));
      directories.push(directory);
      const descendantMutation = join(directory, "descendant-mutation");
      const command = [
        'const {spawn}=require("node:child_process")',
        `const child=spawn(process.execPath,["-e",${JSON.stringify(`setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(descendantMutation)},"escaped"),500);setInterval(()=>{},1000)`)}])`,
        "setInterval(()=>{},1000)",
      ].join(";");

      await expect(
        executeCommand(process.execPath, ["-e", command], {
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 100,
          superviseProcessTree: true,
          trustedPythonPath: "/usr/bin/python3",
        }),
      ).rejects.toThrow("terminated hook process tree");

      await new Promise((resolve) => setTimeout(resolve, 700));
      await expect(readFile(descendantMutation)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "contains and reaps a setsid double-fork before it can mutate later state",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "collect-double-fork-"));
      directories.push(directory);
      const pidFile = join(directory, "daemon.pid");
      const workspaceMutation = join(directory, "workspace-after-cleanup");
      const artifactMutation = join(directory, "artifact-after-cleanup");
      const script = `
import os, time
pid = os.fork()
if pid:
    deadline = time.monotonic() + 2
    while not os.path.exists(${JSON.stringify(pidFile)}) and time.monotonic() < deadline:
        time.sleep(0.01)
    os._exit(0)
os.setsid()
pid = os.fork()
if pid:
    os._exit(0)
with open(${JSON.stringify(pidFile)}, "w", encoding="ascii") as output:
    output.write(str(os.getpid()))
time.sleep(0.5)
for target in (${JSON.stringify(workspaceMutation)}, ${JSON.stringify(artifactMutation)}):
    with open(target, "w", encoding="ascii") as output:
        output.write("escaped")
`;

      const response = await executeCommand("python3", ["-I", "-c", script], {
        cwd: directory,
        env: process.env,
        superviseProcessTree: true,
        trustedPythonPath: "/usr/bin/python3",
        timeoutMs: 5000,
      });

      expect(response.exitCode).toBe(0);
      await expect(readFile(pidFile, "utf8")).resolves.toMatch(/^\d+$/);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(readFile(workspaceMutation)).rejects.toThrow();
      await expect(readFile(artifactMutation)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "fails closed when the trusted supervisor cannot establish",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "collect-fake-python-"));
      directories.push(directory);
      const fakePython = join(directory, "python3");
      const { chmod, writeFile } = await import("node:fs/promises");
      await writeFile(fakePython, "#!/bin/sh\nexit 0\n");
      await chmod(fakePython, 0o755);

      await expect(
        executeCommand(process.execPath, ["-e", ""], {
          cwd: directory,
          env: { PATH: directory },
          superviseProcessTree: true,
          trustedPythonPath: fakePython,
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(
        "hook supervisor failed to establish the Linux subreaper boundary",
      );
    },
  );

  it.skipIf(process.platform !== "linux")(
    "ignores a two-pass PATH interpreter that attempts to spoof the protocol",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "collect-path-spoof-"));
      directories.push(directory);
      const fakePython = join(directory, "python3");
      const marker = join(directory, "fake-python-ran");
      const { chmod, writeFile } = await import("node:fs/promises");
      await writeFile(
        fakePython,
        `#!/bin/sh\nprintf 'READY\\nCLEAN normal\\n' >&3\nprintf spoofed > ${JSON.stringify(marker)}\n`,
      );
      await chmod(fakePython, 0o755);

      for (let pass = 0; pass < 2; pass += 1) {
        const response = await executeCommand(process.execPath, ["-e", ""], {
          cwd: directory,
          env: { ...process.env, PATH: directory },
          superviseProcessTree: true,
          trustedPythonPath: "/usr/bin/python3",
          timeoutMs: 1000,
        });
        expect(response.exitCode).toBe(0);
      }
      await expect(readFile(marker)).rejects.toThrow();
    },
  );
});
