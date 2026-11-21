import type { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import type { getOctokit } from "@actions/github";
import type { ReadClient, ResolvedSource } from "./apply";
import { getArtifactIfPresent } from "./artifact-lookup";
import { IneligibleSourceJobsError, verifySourceJobs } from "./source-jobs";

type SourceReadClient = Pick<
  ReadClient,
  "getWorkflowRun" | "listAssociatedPullRequests"
>;

interface SourceVerificationRequest {
  owner: string;
  repo: string;
  runId: number;
  runAttempt: number;
  sourceWorkflow: string;
  githubToken: string;
}

interface VerifiedSourceRun {
  artifactId: number;
  source: ResolvedSource;
}

/** Verify the triggering attempt and its associated pull request before reporting. */
export async function verifySourceRun(
  artifacts: Pick<DefaultArtifactClient, "getArtifact">,
  octokit: ReturnType<typeof getOctokit>,
  read: SourceReadClient,
  request: SourceVerificationRequest,
): Promise<VerifiedSourceRun | undefined> {
  const { owner, repo, runId, runAttempt, sourceWorkflow, githubToken } =
    request;
  const lookup = await getArtifactIfPresent(
    artifacts,
    runId,
    runAttempt,
    owner,
    repo,
    githubToken,
  );
  if (!lookup) return undefined;

  try {
    await verifySourceJobs(octokit, owner, repo, runId, runAttempt);
  } catch (error) {
    if (!(error instanceof IneligibleSourceJobsError)) throw error;
    core.info(`${error.message}; nothing to fix.`);
    return undefined;
  }

  const source = await resolveSourcePullRequest(read, {
    baseRepository: `${owner}/${repo}`,
    runId,
    sourceWorkflow,
  });
  return { artifactId: lookup.artifact.id, source };
}

interface ResolveSourceRequest {
  baseRepository: string;
  runId: number;
  sourceWorkflow: string;
}

/** Resolve the trusted source run and its single associated open pull request. */
export async function resolveSourcePullRequest(
  read: SourceReadClient,
  request: ResolveSourceRequest,
): Promise<ResolvedSource> {
  const [owner, repo, extra] = request.baseRepository.split("/");
  if (!owner || !repo || extra !== undefined) {
    throw new Error(`invalid repository: ${request.baseRepository}`);
  }
  const run = await read.getWorkflowRun(request.runId);
  if (
    run.id !== request.runId ||
    run.name !== request.sourceWorkflow ||
    run.event !== "pull_request"
  ) {
    throw new Error("source workflow run name or event is not eligible");
  }

  const candidates = (
    await read.listAssociatedPullRequests(run.headSha)
  ).filter(
    (pr) =>
      pr.state === "open" &&
      pr.baseRepository === request.baseRepository &&
      pr.headRepository === run.headRepository &&
      pr.headRef === run.headBranch,
  );
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one associated open pull request; found ${candidates.length}`,
    );
  }
  const pullRequest = candidates[0]!;
  if (pullRequest.headRepositoryNodeId.length === 0) {
    throw new Error("pull request head repository identity is missing");
  }
  return { run, pullRequest };
}
