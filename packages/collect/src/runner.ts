import { artifactName, type FileOperation } from "../../shared/src/artifact";
import { parseExtraArgs } from "./args";
import { openCheckout, type CheckoutDeps } from "./checkout";
export interface CollectContext {
  eventName: string;
  runId: number;
  runAttempt: number;
  repository: string;
  workflow: string;
  pullRequestNumber?: number;
  pullRequestAuthor?: string;
  headSha?: string;
  workspace: string;
  artifactDirectory: string;
}

export interface CollectInputs {
  extraArgs: string;
  ignoreAuthors: string;
  workingDirectory: string;
  maxPasses: number;
  maxLogBytes: number;
  maxFiles: number;
  maxBytes: number;
  passTimeoutSeconds: number;
}

export interface CollectDeps extends CheckoutDeps {
  setOutput(name: string, value: string): void;
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
  "UV_CACHE_DIR",
  "UV_FROZEN",
  "UV_LOCKED",
  "UV_NO_CONFIG",
  "UV_OFFLINE",
  "XDG_CACHE_HOME",
]);

export function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => SAFE_CHILD_ENVIRONMENT.has(key)),
  );
}

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
  if (!Number.isSafeInteger(inputs.maxFiles) || inputs.maxFiles < 0) {
    throw new Error("max-files must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(inputs.maxBytes) || inputs.maxBytes < 0) {
    throw new Error("max-bytes must be a nonnegative safe integer");
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
  const ignoredAuthors = inputs.ignoreAuthors
    .split(/[,\r\n]/)
    .map((author) => author.trim().toLowerCase())
    .filter(Boolean);
  if (
    ignoredAuthors.some(
      (author) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\[bot\])?$/.test(author),
    )
  ) {
    throw new Error(
      "ignore-authors must contain comma- or newline-separated GitHub logins",
    );
  }
  if (ignoredAuthors.length > 0 && !context.pullRequestAuthor) {
    throw new Error(
      "pull request author is required when ignore-authors is nonempty",
    );
  }
  const autofixIgnored = ignoredAuthors.includes(
    context.pullRequestAuthor?.toLowerCase() ?? "",
  );
  const checkout = await openCheckout(
    {
      workspace: context.workspace,
      workingDirectory: inputs.workingDirectory,
      artifactDirectory: context.artifactDirectory,
      source: {
        runId: context.runId,
        runAttempt: context.runAttempt,
        repository: context.repository,
        workflow: context.workflow,
        event: "pull_request",
        pullRequestNumber: context.pullRequestNumber,
        headSha: context.headSha,
      },
      maxFiles: inputs.maxFiles,
      maxBytes: inputs.maxBytes,
    },
    {
      execute: deps.execute,
      env: sanitizedEnvironment(deps.env),
      collectChanges: deps.collectChanges,
    },
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
    const result = await checkout.runPass(
      args,
      inputs.maxLogBytes,
      inputs.passTimeoutSeconds * 1000,
    );
    operations = result.operations;
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

  deps.setOutput("changed", String(!autofixIgnored && operations.length > 0));
  deps.setOutput("artifact-name", "");
  deps.setOutput("artifact-path", "");
  if (!converged && !hardFailure) {
    throw new NonConvergenceError(
      `prek did not converge after ${inputs.maxPasses} passes`,
    );
  }
  if (autofixIgnored) {
    if (operations.length > 0) {
      throw new HardFailureError(
        "prek generated fixes, but autofix is disabled for this pull request author; apply the fixes locally",
      );
    }
    if (hardFailure) throw hardFailure;
    return;
  }
  if (operations.length > 0) {
    const file = await checkout.persist(operations);
    deps.setOutput(
      "artifact-name",
      artifactName(context.runId, context.runAttempt),
    );
    deps.setOutput("artifact-path", file);
  }
  if (hardFailure && operations.length === 0) throw hardFailure;
}
