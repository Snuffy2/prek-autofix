import * as core from "@actions/core";
import {
  ArtifactValidationError,
  COMMENT_MARKER,
} from "../../shared/src/artifact";
import {
  ApplyError,
  FORK_AUTOFIX_TOKEN_REQUIRED,
  SAFE_BRANCH_UPDATE_REJECTED,
  type CommitStatusState,
  type ReadClient,
  type ResolvedSource,
  type StatusClient,
} from "./apply";

const UNEXPECTED_FAILURE = "the fix action failed unexpectedly";
const STALE_PULL_REQUEST_HEAD =
  "the pull request head changed after collection";

export interface FixReporter {
  pending(): Promise<void>;
  success(): Promise<void>;
  failure(error: unknown): Promise<void>;
}

export interface FixReporterRequest {
  source: ResolvedSource;
  fixRunUrl: string;
  artifactUrl: string;
  sourceRunUrl: string;
}

interface PublicFailure {
  description: string;
  reason: string;
}

function publicFailure(error: unknown): PublicFailure {
  if (
    error instanceof ArtifactValidationError ||
    error instanceof SyntaxError
  ) {
    return {
      description: "Generated artifact failed validation",
      reason: "the generated artifact failed security validation",
    };
  }
  if (error instanceof ApplyError) {
    const message = error.message;
    if (message === STALE_PULL_REQUEST_HEAD) {
      return { description: "Pull request head changed", reason: message };
    }
    if (message === FORK_AUTOFIX_TOKEN_REQUIRED) {
      return {
        description: "Cannot update fork: PREK_AUTOFIX_TOKEN is not configured",
        reason: message,
      };
    }
    if (
      message === "only user-owned forks are eligible" ||
      message === "the fork does not allow maintainer edits" ||
      message === "the pull request is no longer eligible for autofix" ||
      message === "the pull request source changed before autofix" ||
      message === "the fork no longer allows maintainer edits" ||
      message === "GitHub rejected the fix commit" ||
      message ===
        "GITHUB_TOKEN could not update the pull request branch; grant contents: write or configure PREK_AUTOFIX_TOKEN" ||
      message === SAFE_BRANCH_UPDATE_REJECTED
    ) {
      return { description: message.slice(0, 140), reason: message };
    }
    return {
      description: "Generated fixes could not be applied safely",
      reason: "the generated fixes could not be applied safely",
    };
  }
  if (
    error instanceof Error &&
    /input required and not supplied: autofix-token/i.test(error.message)
  ) {
    return {
      description: "autofix-token resolved empty",
      reason:
        "`autofix-token` resolved empty. Configure the `PREK_AUTOFIX_TOKEN` repository secret and confirm that it is available to this workflow",
    };
  }
  if (
    error instanceof Error &&
    (error.message === "artifact download path is missing" ||
      error.message === "artifact JSON is too large")
  ) {
    return {
      description: "Generated artifact could not be read safely",
      reason: "the generated artifact could not be read safely",
    };
  }
  return {
    description: "Fix action failed unexpectedly",
    reason: UNEXPECTED_FAILURE,
  };
}

async function bestEffort(
  label: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch {
    core.warning(`prek-autofix could not publish its ${label}`);
  }
}

export function createFixReporter(
  read: ReadClient,
  status: StatusClient,
  request: FixReporterRequest,
): FixReporter {
  const { pullRequest, run } = request.source;
  const setStatus = (state: CommitStatusState, description: string) =>
    bestEffort("pull request status", () =>
      status.setCommitStatus(
        run.headSha,
        state,
        description,
        request.fixRunUrl,
      ),
    );

  return {
    async pending() {
      await setStatus("pending", "Applying generated prek fixes");
    },
    async success() {
      await setStatus("success", "Generated prek fixes were applied");
    },
    async failure(error) {
      const failure = publicFailure(error);
      const publications = [setStatus("failure", failure.description)];
      if (!(
        error instanceof ApplyError && error.message === STALE_PULL_REQUEST_HEAD
      )) {
        publications.push(
          bestEffort("pull request recovery comment", () =>
            read.upsertComment(
              pullRequest.number,
              `${COMMENT_MARKER}
prek-autofix could not apply the generated changes: **${failure.reason}.**

[Inspect the fix run](${request.fixRunUrl}), [download the generated artifact](${request.artifactUrl}), or [inspect the source run](${request.sourceRunUrl}). Apply the fixes locally, push them to the pull request branch, and rerun the checks.`,
            ),
          ),
        );
      }
      await Promise.all(publications);
    },
  };
}
