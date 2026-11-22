import * as core from "@actions/core";
import {
  ArtifactLimitError,
  ArtifactValidationError,
  COMMENT_MARKER,
} from "../../shared/src/artifact";
import {
  ApplyError,
  ApplyOutcomeError,
  ArtifactLimitConfigurationError,
  type ResolvedSource,
} from "./apply";

const FORK_AUTOFIX_TOKEN_REQUIRED =
  "Cannot apply fixes to this fork because the GitHub PAT token PREK_AUTOFIX_TOKEN is not configured. The repo owner needs add that token before autofix will work. [See instructions here](https://github.com/Snuffy2/prek-autofix#1-create-the-cross-repository-token-when-needed)";
const SAFE_BRANCH_UPDATE_REJECTED =
  "GitHub could not update the pull request branch because it changed or the update was not allowed";

const applicationReasons = {
  "fork-owner-ineligible": "only user-owned forks are eligible",
  "fork-edits-disabled": "the fork does not allow maintainer edits",
  "source-ineligible": "the pull request is no longer eligible for autofix",
  "source-changed": "the pull request source changed before autofix",
  "fork-edits-revoked": "the fork no longer allows maintainer edits",
};

type CommitStatusState = "pending" | "success" | "failure";

export interface StatusClient {
  setCommitStatus(
    sha: string,
    state: CommitStatusState,
    description: string,
    targetUrl: string,
  ): Promise<void>;
}

export interface FixCommentClient {
  upsertComment(prNumber: number, body: string): Promise<void>;
  markCommentObsolete(prNumber: number): Promise<void>;
  resolveComment(prNumber: number): Promise<void>;
}

export interface FixReporter {
  pending(): Promise<void>;
  success(): Promise<void>;
  failure(error: unknown): Promise<Error>;
}

export interface FixReporterRequest {
  source: ResolvedSource;
  fixRunUrl: string;
  sourceRunUrl: string;
}

interface PublicFailure {
  description: string;
  reason: string;
  obsolete?: boolean;
  actionMessage?: string;
}

function publicFailure(error: unknown): PublicFailure {
  if (
    error instanceof ArtifactValidationError ||
    error instanceof SyntaxError
  ) {
    return {
      description: "Generated artifact failed validation",
      reason: "the generated artifact failed security validation",
      actionMessage:
        error instanceof ArtifactLimitError ? error.message : undefined,
    };
  }
  if (error instanceof ArtifactLimitConfigurationError) {
    return {
      description: "Configured artifact limits are too large",
      reason: `the ${error.message}. Reduce the \`max-files\` or \`max-bytes\` input`,
      actionMessage: error.message,
    };
  }
  if (error instanceof ApplyOutcomeError) {
    const outcome = error.outcome;
    switch (outcome.kind) {
      case "stale-head":
        return {
          description: "Pull request head changed",
          reason: "the pull request head changed after collection",
          obsolete: true,
        };
      case "fork-token-required":
        return {
          description:
            "Cannot update fork: PREK_AUTOFIX_TOKEN is not configured",
          reason: FORK_AUTOFIX_TOKEN_REQUIRED,
        };
      case "mutation-rejected": {
        const { status, usedGithubTokenFallback } = outcome;
        const reason =
          status === 409 || status === 422
            ? SAFE_BRANCH_UPDATE_REJECTED
            : status === 403 && usedGithubTokenFallback
              ? "GITHUB_TOKEN could not update the pull request branch; grant contents: write or configure PREK_AUTOFIX_TOKEN"
              : "GitHub rejected the fix commit";
        return { description: reason, reason };
      }
      default: {
        const reason = applicationReasons[outcome.kind];
        return { description: reason, reason };
      }
    }
  }
  if (error instanceof ApplyError) {
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
      actionMessage: error.message,
    };
  }
  return {
    description: "Fix action failed unexpectedly",
    reason: "the fix action failed unexpectedly",
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
  comments: FixCommentClient,
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
      await Promise.all([
        setStatus("success", "Generated prek fixes were applied"),
        bestEffort("resolved pull request recovery comment", () =>
          comments.resolveComment(pullRequest.number),
        ),
      ]);
    },
    async failure(error) {
      const failure = publicFailure(error);
      const comment = failure.obsolete
        ? bestEffort("obsolete pull request recovery comment", () =>
            comments.markCommentObsolete(pullRequest.number),
          )
        : bestEffort("pull request recovery comment", () =>
            comments.upsertComment(
              pullRequest.number,
              `${COMMENT_MARKER}
prek-autofix could not apply the generated changes: **${failure.reason}.**

[Inspect the fix run](${request.fixRunUrl}) or [inspect the source run](${request.sourceRunUrl}). To recover locally, run the repository's configured prek command (normally \`prek run -a\`), address any remaining issues, and push the changes.`,
            ),
          );
      await Promise.all([setStatus("failure", failure.description), comment]);
      return new Error(failure.actionMessage ?? failure.reason);
    },
  };
}
