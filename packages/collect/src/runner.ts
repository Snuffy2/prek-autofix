import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { FileOperation } from "../../shared/src/artifact";
import {
  ARTIFACT_SCHEMA_VERSION,
  artifactName,
  parseChangeArtifact,
  validatePathComponentBudget,
} from "../../shared/src/artifact";
import { HOOK_SUPERVISOR_SCRIPT } from "./hook-supervisor";
import { parseExtraArgs } from "./args";
import {
  assertExactCleanCheckout,
  assertExactHead,
  assertRootIdentity,
  assertTrustedPython,
  captureRootIdentity,
  captureTrustedPython,
  collectOperations,
  type CommandResult,
  type Execute,
  type RootIdentity,
  writeArtifact,
} from "./git";

export interface CollectContext {
  eventName: string;
  runId: number;
  runAttempt: number;
  repository: string;
  workflow: string;
  pullRequestNumber?: number;
  headSha?: string;
  workspace: string;
  artifactDirectory: string;
}

export interface CollectInputs {
  extraArgs: string;
  workingDirectory: string;
  maxPasses: number;
  maxLogBytes: number;
  passTimeoutSeconds: number;
}

export interface CollectDeps {
  execute: Execute;
  env: NodeJS.ProcessEnv;
  setOutput(name: string, value: string): void;
  collectChanges?: (
    root: string,
    execute: Execute,
    env: NodeJS.ProcessEnv,
    expectedRoot: RootIdentity,
  ) => Promise<FileOperation[]>;
  persistArtifact?: typeof writeArtifact;
  platform?: NodeJS.Platform;
}

export class HardFailureError extends Error {}
export class NonConvergenceError extends Error {}

const SAFE_CHILD_ENVIRONMENT = new Set([
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_BASE_REF",
  "GITHUB_EVENT_NAME",
  "GITHUB_HEAD_REF",
  "GITHUB_REF",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "GITHUB_WORKSPACE",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PREK_HOME",
  "PRE_COMMIT_HOME",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
]);

export function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => SAFE_CHILD_ENVIRONMENT.has(key)),
  );
}

export function streamUntrustedOutput(
  source: Pick<Readable, "pause" | "resume">,
  target: {
    write(chunk: string): boolean;
    once(event: "drain", listener: () => void): unknown;
  },
  limitBytes: number,
): {
  write(chunk: Buffer): void;
  end(): void;
} {
  const decoder = new StringDecoder("utf8");
  let atLineStart = true;
  let previousWasCarriageReturn = false;
  let acceptedBytes = 0;
  let truncated = false;
  let waitingForDrain = false;
  let decoderEnded = false;
  const write = (text: string): void => {
    if (text.length === 0) return;
    const output: string[] = [];
    for (const character of text) {
      if (previousWasCarriageReturn && character === "\n") {
        output.push(character);
        previousWasCarriageReturn = false;
        continue;
      }
      previousWasCarriageReturn = false;
      if (atLineStart) {
        output.push("[prek] ");
        atLineStart = false;
      }
      output.push(character);
      if (character === "\r") {
        previousWasCarriageReturn = true;
        atLineStart = true;
      } else if (character === "\n") {
        atLineStart = true;
      }
    }
    if (!target.write(output.join("")) && !waitingForDrain) {
      waitingForDrain = true;
      source.pause();
      target.once("drain", () => {
        waitingForDrain = false;
        source.resume();
      });
    }
  };
  const truncate = (): void => {
    if (truncated) return;
    truncated = true;
    decoderEnded = true;
    write(decoder.end());
    if (!atLineStart) write("\n");
    write(`output truncated after ${limitBytes} bytes\n`);
  };
  return {
    write: (chunk) => {
      const remaining = limitBytes - acceptedBytes;
      if (remaining <= 0) {
        if (chunk.length > 0) truncate();
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      acceptedBytes += accepted.length;
      write(decoder.write(accepted));
      if (accepted.length < chunk.length) truncate();
    },
    end: () => {
      if (!decoderEnded) write(decoder.end());
      if (!atLineStart) write("\n");
    },
  };
}

export const executeCommand: Execute = async (command, args, options) =>
  await new Promise<CommandResult>((finish, reject) => {
    const useProcessGroup = process.platform === "linux";
    if (options.superviseProcessTree && !useProcessGroup) {
      reject(new Error("secure hook process cleanup requires Linux"));
      return;
    }
    const supervised = options.superviseProcessTree === true;
    if (
      supervised &&
      (!options.trustedPythonPath || !isAbsolute(options.trustedPythonPath))
    ) {
      reject(
        new Error("secure hook supervision requires a pinned Python path"),
      );
      return;
    }
    const spawnedCommand = supervised ? options.trustedPythonPath! : command;
    const spawnedArgs = supervised
      ? [
          "-I",
          "-c",
          HOOK_SUPERVISOR_SCRIPT,
          String((options.timeoutMs ?? 0) / 1000),
          command,
          ...args,
        ]
      : args;
    const child = spawn(spawnedCommand, spawnedArgs, {
      cwd: options.cwd,
      env: options.env,
      detached: useProcessGroup,
      stdio: supervised
        ? ["ignore", "pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let captureOverflow = false;
    let forceKill: NodeJS.Timeout | undefined;
    const protocol: Buffer[] = [];
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(useProcessGroup ? -child.pid : child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const streamedStdout = options.streamUntrustedOutput
      ? streamUntrustedOutput(
          child.stdout!,
          process.stdout,
          options.streamLimitBytes ?? 1048576,
        )
      : undefined;
    const streamedStderr = options.streamUntrustedOutput
      ? streamUntrustedOutput(
          child.stderr!,
          process.stderr,
          options.streamLimitBytes ?? 1048576,
        )
      : undefined;
    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      const limit = options.captureLimitBytes;
      if (
        limit !== undefined &&
        (captureOverflow || chunk.byteLength > limit - capturedBytes)
      ) {
        if (!captureOverflow) {
          captureOverflow = true;
          terminate("SIGTERM");
          if (!supervised) {
            forceKill = setTimeout(() => terminate("SIGKILL"), 2000);
            forceKill.unref();
          }
        }
        return;
      }
      capturedBytes += chunk.byteLength;
      chunks.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      if (streamedStdout) streamedStdout.write(chunk);
      else capture(stdout, chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (streamedStderr) streamedStderr.write(chunk);
      else capture(stderr, chunk);
    });
    let timedOut = false;
    const timeoutError = (): Error =>
      new Error(
        `${options.timeoutDescription ?? "prek pass"} timed out after ${Math.ceil((options.timeoutMs ?? 0) / 1000)} seconds; terminated ${options.timeoutDescription ? "process" : "hook process"}${supervised || useProcessGroup ? " tree" : ""}`,
      );
    const timeout =
      options.timeoutMs === undefined || supervised
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate("SIGTERM");
            forceKill = setTimeout(() => {
              terminate("SIGKILL");
              reject(timeoutError());
            }, 2000);
          }, options.timeoutMs);
    timeout?.unref();
    if (supervised) {
      const protocolStream = child.stdio[3];
      if (protocolStream && "on" in protocolStream) {
        protocolStream.on("data", (chunk: Buffer) => {
          if (Buffer.concat(protocol).byteLength + chunk.byteLength <= 4096) {
            protocol.push(chunk);
          }
        });
      }
    }
    const forwardedSignals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const signalHandlers = new Map<NodeJS.Signals, () => void>(
      forwardedSignals.map((signal) => [signal, () => terminate(signal)]),
    );
    if (supervised) {
      for (const signal of forwardedSignals) {
        process.on(signal, signalHandlers.get(signal)!);
      }
    }
    const removeSignalHandlers = (): void => {
      if (!supervised) return;
      for (const signal of forwardedSignals) {
        process.off(signal, signalHandlers.get(signal)!);
      }
    };
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      removeSignalHandlers();
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      streamedStdout?.end();
      streamedStderr?.end();
      removeSignalHandlers();
      if (timedOut) {
        if (useProcessGroup) return;
        if (forceKill) clearTimeout(forceKill);
        reject(timeoutError());
        return;
      }
      if (captureOverflow) {
        reject(
          new Error(
            `command output exceeded capture limit of ${options.captureLimitBytes} bytes`,
          ),
        );
        return;
      }
      if (forceKill) clearTimeout(forceKill);
      const complete = async (): Promise<void> => {
        if (supervised) {
          const records = Buffer.concat(protocol).toString("ascii").split("\n");
          if (!records.includes("READY")) {
            throw new Error(
              "hook supervisor failed to establish the Linux subreaper boundary",
            );
          }
          if (!records.includes("NON_DUMPABLE")) {
            throw new Error(
              "hook supervisor failed to protect its protocol channel",
            );
          }
          if (records.includes("CLEANUP_FAILED")) {
            throw new Error(
              "hook supervisor could not prove that all hook descendants exited",
            );
          }
          if (records.includes("SPAWN_FAILED")) {
            throw new Error("hook supervisor could not start prek");
          }
          if (records.includes("CLEAN timeout")) throw timeoutError();
          if (records.includes("CLEAN signal")) {
            throw new Error("prek pass interrupted after hook process cleanup");
          }
          if (!records.includes("CLEAN normal")) {
            throw new Error(
              "hook supervisor exited without proving descendant cleanup",
            );
          }
        }
        finish({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      };
      void complete().catch(reject);
    });
  });

function validateContext(
  context: CollectContext,
): asserts context is CollectContext & {
  pullRequestNumber: number;
  headSha: string;
} {
  if (!Number.isSafeInteger(context.runAttempt) || context.runAttempt <= 0) {
    throw new Error("runAttempt must be a positive integer");
  }
  if (
    context.eventName !== "pull_request" ||
    !Number.isSafeInteger(context.pullRequestNumber) ||
    (context.pullRequestNumber ?? 0) <= 0 ||
    !context.headSha ||
    !/^[0-9a-f]{40}$/.test(context.headSha)
  ) {
    throw new Error("review action requires a pull_request context");
  }
}

export async function runCollect(
  context: CollectContext,
  inputs: CollectInputs,
  deps: CollectDeps,
): Promise<void> {
  validateContext(context);
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new Error("secure collection requires a Linux runner");
  }
  if (!Number.isSafeInteger(inputs.maxPasses) || inputs.maxPasses <= 0) {
    throw new Error("max-passes must be a positive integer");
  }
  if (
    !Number.isSafeInteger(inputs.maxLogBytes) ||
    inputs.maxLogBytes < 1024 ||
    inputs.maxLogBytes > 10485760
  ) {
    throw new Error(
      "max-log-bytes must be an integer between 1024 and 10485760",
    );
  }
  if (
    !Number.isSafeInteger(inputs.passTimeoutSeconds) ||
    inputs.passTimeoutSeconds < 1 ||
    inputs.passTimeoutSeconds > 3600
  ) {
    throw new Error(
      "pass-timeout-seconds must be an integer between 1 and 3600",
    );
  }
  const workspace = resolve(context.workspace);
  const workspaceIdentity = await captureRootIdentity(workspace);
  const artifactRoot = resolve(context.artifactDirectory);
  const artifactRootIdentity = await captureRootIdentity(artifactRoot);
  const trustedPython = await captureTrustedPython();
  const canonicalWorkspace = workspaceIdentity.canonicalPath;
  const rootPathname = resolve(canonicalWorkspace, inputs.workingDirectory);
  const rel = relative(canonicalWorkspace, rootPathname);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error("working-directory must be inside the workspace");
  }
  const workingRootIdentity = await captureRootIdentity(rootPathname);
  const canonicalRoot = workingRootIdentity.canonicalPath;
  const canonicalRel = relative(canonicalWorkspace, canonicalRoot);
  if (
    canonicalRel === ".." ||
    canonicalRel.startsWith("../") ||
    canonicalRel.startsWith("..\\")
  ) {
    throw new Error("working-directory must resolve inside the workspace");
  }
  const childEnv = sanitizedEnvironment(deps.env);
  await assertTrustedPython(trustedPython);
  const python = await deps.execute(
    trustedPython.canonicalPath,
    ["-I", "-c", "import os, stat"],
    { cwd: canonicalWorkspace, env: childEnv, captureLimitBytes: 4096 },
  );
  if (python.exitCode !== 0) {
    throw new Error("secure collection requires Python 3");
  }
  await assertExactCleanCheckout(
    canonicalWorkspace,
    context.headSha,
    deps.execute,
    childEnv,
  );
  const args = [
    "run",
    "--show-diff-on-failure",
    "--color=always",
    ...parseExtraArgs(inputs.extraArgs),
  ];

  let previous = "";
  let operations: FileOperation[] = [];
  let hardFailure: Error | undefined;
  let converged = false;
  for (let pass = 1; pass <= inputs.maxPasses; pass += 1) {
    await assertTrustedPython(trustedPython);
    const result = await deps.execute("prek", args, {
      cwd: canonicalRoot,
      env: childEnv,
      streamUntrustedOutput: true,
      streamLimitBytes: inputs.maxLogBytes,
      superviseProcessTree: true,
      trustedPythonPath: trustedPython.canonicalPath,
      timeoutMs: inputs.passTimeoutSeconds * 1000,
    });
    await assertRootIdentity(workspace, workspaceIdentity);
    await assertRootIdentity(rootPathname, workingRootIdentity);
    await assertExactHead(
      canonicalWorkspace,
      context.headSha,
      deps.execute,
      childEnv,
    );
    operations = deps.collectChanges
      ? await deps.collectChanges(
          canonicalWorkspace,
          deps.execute,
          childEnv,
          workspaceIdentity,
        )
      : await collectOperations(
          canonicalWorkspace,
          deps.execute,
          childEnv,
          undefined,
          undefined,
          0,
          workspaceIdentity,
          trustedPython,
        );
    const snapshot = JSON.stringify(operations);
    if (operations.length === 0 || snapshot === previous) {
      if (result.exitCode === 0) {
        converged = true;
      } else {
        hardFailure = new HardFailureError(
          `prek failed without making new fixes (exit ${result.exitCode})`,
        );
      }
      break;
    }
    previous = snapshot;
  }

  deps.setOutput("changed", String(operations.length > 0));
  deps.setOutput("artifact-name", "");
  deps.setOutput("artifact-path", "");
  if (!converged && !hardFailure) {
    throw new NonConvergenceError(
      `prek did not converge after ${inputs.maxPasses} passes`,
    );
  }
  if (operations.length > 0) {
    await assertRootIdentity(workspace, workspaceIdentity);
    await assertRootIdentity(artifactRoot, artifactRootIdentity);
    await assertTrustedPython(trustedPython);
    await assertExactHead(
      canonicalWorkspace,
      context.headSha,
      deps.execute,
      childEnv,
    );
    validatePathComponentBudget(operations.map(({ path }) => path));
    const artifact = parseChangeArtifact({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      source: {
        runId: context.runId,
        runAttempt: context.runAttempt,
        repository: context.repository,
        workflow: context.workflow,
        event: "pull_request",
        pullRequestNumber: context.pullRequestNumber,
        headSha: context.headSha,
      },
      operations,
    });
    const file = await (deps.persistArtifact ?? writeArtifact)(
      context.artifactDirectory,
      artifact,
      artifactRootIdentity,
    );
    await assertRootIdentity(workspace, workspaceIdentity);
    await assertRootIdentity(artifactRoot, artifactRootIdentity);
    await assertExactHead(
      canonicalWorkspace,
      context.headSha,
      deps.execute,
      childEnv,
    );
    deps.setOutput(
      "artifact-name",
      artifactName(context.runId, context.runAttempt),
    );
    deps.setOutput("artifact-path", file);
  }
  if (hardFailure && operations.length === 0) throw hardFailure;
}
