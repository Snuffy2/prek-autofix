import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_COMMIT_MESSAGE,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  parseChangeArtifact,
} from "../../shared/src/artifact";
import { versionBanner } from "../../shared/src/version";
import { getArtifactIfPresent } from "./artifact-lookup";
import {
  applyArtifact,
  maximumRawArtifactBytes,
  resolveSourcePullRequest,
} from "./apply";
import {
  createMutationClient,
  createReadClient,
  createStatusClient,
} from "./github";
import { createFixReporter } from "./reporting";
import { IneligibleSourceJobsError, verifySourceJobs } from "./source-jobs";
import { selectMutationToken } from "./token";

function nonnegativeInput(name: string, fallback: number): number {
  const raw = core.getInput(name);
  const value = raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

async function run(): Promise<void> {
  if (github.context.eventName !== "workflow_run") {
    throw new Error("fix action may only run for workflow_run");
  }
  const runId = Number(github.context.payload.workflow_run?.id);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("workflow_run.id is required");
  }
  const runAttempt = Number(github.context.payload.workflow_run?.run_attempt);
  if (!Number.isSafeInteger(runAttempt) || runAttempt <= 0) {
    throw new Error("workflow_run.run_attempt is required");
  }
  core.info(versionBanner());
  const [owner, repo] = github.context.repo.owner
    ? [github.context.repo.owner, github.context.repo.repo]
    : ["", ""];
  const baseRepository = `${owner}/${repo}`;
  const githubToken = core.getInput("github-token", { required: true });
  core.setSecret(githubToken);
  const maxFiles = nonnegativeInput("max-files", DEFAULT_MAX_FILES);
  const maxBytes = nonnegativeInput("max-bytes", DEFAULT_MAX_BYTES);
  const sourceWorkflow = core.getInput("source-workflow") || "prek-autofix";
  const commitMessage =
    core.getInput("commit-message") || DEFAULT_COMMIT_MESSAGE;

  const artifactClient = new DefaultArtifactClient();
  const readOctokit = github.getOctokit(githubToken);
  const lookup = await getArtifactIfPresent(
    artifactClient,
    runId,
    runAttempt,
    owner,
    repo,
    githubToken,
  );
  if (!lookup) return;
  try {
    await verifySourceJobs(readOctokit, owner, repo, runId, runAttempt);
  } catch (error) {
    if (!(error instanceof IneligibleSourceJobsError)) throw error;
    core.info(`${error.message}; nothing to fix.`);
    return;
  }
  const read = createReadClient(readOctokit, owner, repo);
  const source = await resolveSourcePullRequest(read, {
    baseRepository,
    runId,
    sourceWorkflow,
  });
  const sourceRunUrl = `${github.context.serverUrl}/${baseRepository}/actions/runs/${runId}`;
  const fixRunUrl = `${github.context.serverUrl}/${baseRepository}/actions/runs/${github.context.runId}`;
  const reporter = createFixReporter(
    read,
    createStatusClient(readOctokit, owner, repo),
    { source, fixRunUrl, sourceRunUrl },
  );
  await reporter.pending();

  try {
    const download = await artifactClient.downloadArtifact(lookup.artifact.id, {
      findBy: {
        token: githubToken,
        workflowRunId: runId,
        repositoryOwner: owner,
        repositoryName: repo,
      },
    });
    if (!download.downloadPath)
      throw new Error("artifact download path is missing");
    const artifactPath = join(download.downloadPath, "prek-autofix.json");
    const rawLimit = maximumRawArtifactBytes(maxBytes, maxFiles);
    const fileStat = await stat(artifactPath);
    if (fileStat.size > rawLimit) throw new Error("artifact JSON is too large");
    const raw = await readFile(artifactPath, "utf8");
    if (Buffer.byteLength(raw) > rawLimit)
      throw new Error("artifact JSON is too large");
    const artifact = parseChangeArtifact(JSON.parse(raw), maxFiles, maxBytes);

    const mutationCredential = selectMutationToken(
      core.getInput("autofix-token"),
      githubToken,
    );
    core.setSecret(mutationCredential.token);
    const mutationOctokit = github.getOctokit(mutationCredential.token);
    const mutation = createMutationClient(mutationOctokit);
    await applyArtifact(read, mutation, {
      baseRepository,
      runId,
      runAttempt,
      artifact,
      sourceRunUrl,
      sourceWorkflow,
      commitMessage,
      mutationTokenUsedGithubFallback:
        mutationCredential.usedGithubTokenFallback,
      source,
    });
  } catch (error) {
    await reporter.failure(error);
    throw error;
  }
  await reporter.success();
}

void run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
