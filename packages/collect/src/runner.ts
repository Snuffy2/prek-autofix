import { spawn } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ArtifactClient } from "@actions/artifact";
import type { ChangeArtifact } from "../../shared/src/artifact";
import type { FileOperation } from "../../shared/src/artifact";
import {
  ARTIFACT_SCHEMA_VERSION,
  artifactName,
} from "../../shared/src/artifact";
import { parseExtraArgs } from "./args";
import {
  assertExactCleanCheckout,
  collectOperations,
  type CommandResult,
  type Execute,
  writeArtifact,
} from "./git";

export interface CollectContext {
  eventName: string;
  runId: number;
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
}

export interface CollectDeps {
  execute: Execute;
  artifact: Pick<ArtifactClient, "uploadArtifact">;
  env: NodeJS.ProcessEnv;
  setOutput(name: string, value: string): void;
  collectChanges?: (
    root: string,
    execute: Execute,
    env: NodeJS.ProcessEnv,
  ) => Promise<FileOperation[]>;
  persistArtifact?: typeof writeArtifact;
}

export class HardFailureError extends Error {}
export class NonConvergenceError extends Error {}
export class FixesFoundError extends Error {}

export function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const githubFileCommands = new Set([
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_STEP_SUMMARY",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/(?:TOKEN|SECRET|PASSWORD|AUTH)/i.test(key) &&
        !githubFileCommands.has(key),
    ),
  );
}

function streamUntrustedOutput(target: NodeJS.WriteStream): {
  write(chunk: Buffer): void;
  end(): void;
} {
  const decoder = new StringDecoder("utf8");
  let atLineStart = true;
  let previousWasCarriageReturn = false;
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
    target.write(output.join(""));
  };
  return {
    write: (chunk) => write(decoder.write(chunk)),
    end: () => write(decoder.end()),
  };
}

export const executeCommand: Execute = async (command, args, options) =>
  await new Promise<CommandResult>((finish, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const streamedStdout = options.streamUntrustedOutput
      ? streamUntrustedOutput(process.stdout)
      : undefined;
    const streamedStderr = options.streamUntrustedOutput
      ? streamUntrustedOutput(process.stderr)
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      if (streamedStdout) streamedStdout.write(chunk);
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (streamedStderr) streamedStderr.write(chunk);
      else stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      streamedStdout?.end();
      streamedStderr?.end();
      finish({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });

function validateContext(context: CollectContext): asserts context is CollectContext & {
  pullRequestNumber: number;
  headSha: string;
} {
  if (
    context.eventName !== "pull_request" ||
    !Number.isSafeInteger(context.pullRequestNumber) ||
    (context.pullRequestNumber ?? 0) <= 0 ||
    !context.headSha ||
    !/^[0-9a-f]{40}$/.test(context.headSha)
  ) {
    throw new Error("collect action requires a pull_request context");
  }
}

export async function runCollect(
  context: CollectContext,
  inputs: CollectInputs,
  deps: CollectDeps,
): Promise<void> {
  validateContext(context);
  if (!Number.isSafeInteger(inputs.maxPasses) || inputs.maxPasses <= 0) {
    throw new Error("max-passes must be a positive integer");
  }
  const workspace = resolve(context.workspace);
  const root = resolve(workspace, inputs.workingDirectory);
  const rel = relative(workspace, root);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error("working-directory must be inside the workspace");
  }
  const childEnv = sanitizedEnvironment(deps.env);
  await assertExactCleanCheckout(
    workspace,
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
    const result = await deps.execute("prek", args, {
      cwd: root,
      env: childEnv,
      streamUntrustedOutput: true,
    });
    operations = await (deps.collectChanges ?? collectOperations)(
      workspace,
      deps.execute,
      childEnv,
    );
    const snapshot = JSON.stringify(operations);
    if (result.exitCode === 0) {
      converged = true;
      break;
    }
    if (operations.length === 0 || snapshot === previous) {
      hardFailure = new HardFailureError(
        `prek failed without making new fixes (exit ${result.exitCode})`,
      );
      break;
    }
    previous = snapshot;
  }

  deps.setOutput("changed", String(operations.length > 0));
  if (!converged && !hardFailure) {
    deps.setOutput("artifact-name", "");
    throw new NonConvergenceError(
      `prek did not converge after ${inputs.maxPasses} passes`,
    );
  }
  deps.setOutput(
    "artifact-name",
    operations.length ? artifactName(context.runId) : "",
  );
  if (operations.length > 0) {
    const artifact: ChangeArtifact = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      source: {
        runId: context.runId,
        repository: context.repository,
        workflow: context.workflow,
        event: "pull_request",
        pullRequestNumber: context.pullRequestNumber,
        headSha: context.headSha,
      },
      operations,
    };
    const file = await (deps.persistArtifact ?? writeArtifact)(
      context.artifactDirectory,
      artifact,
    );
    await deps.artifact.uploadArtifact(
      artifactName(context.runId),
      [file],
      dirname(file),
    );
  }
  if (hardFailure) throw hardFailure;
  if (operations.length > 0) {
    throw new FixesFoundError("prek generated fixes; artifact uploaded");
  }
}
