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
import { getArtifactIfPresent } from "./artifact-lookup";
import {
  applyArtifact,
  maximumRawArtifactBytes,
} from "./apply";
import { createMutationClient, createReadClient } from "./github";
import {
  IneligibleSourceJobsError,
  verifySourceJobs,
} from "./source-jobs";

function positiveInput(name: string, fallback: number): number {
  const raw = core.getInput(name);
  const value = raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

async function run(): Promise<void> {
  if (github.context.eventName !== "workflow_run") {
    throw new Error("apply action may only run for workflow_run");
  }
  const runId = Number(github.context.payload.workflow_run?.id);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("workflow_run.id is required");
  }
  const [owner, repo] = github.context.repo.owner
    ? [github.context.repo.owner, github.context.repo.repo]
    : ["", ""];
  const baseRepository = `${owner}/${repo}`;
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) throw new Error("GITHUB_TOKEN is required");
  const maxFiles = positiveInput("max-files", DEFAULT_MAX_FILES);
  const maxBytes = positiveInput("max-bytes", DEFAULT_MAX_BYTES);
  const sourceWorkflow = core.getInput("source-workflow") || "prek-autofix";
  const commitMessage =
    core.getInput("commit-message") || DEFAULT_COMMIT_MESSAGE;

  const artifactClient = new DefaultArtifactClient();
  const readOctokit = github.getOctokit(githubToken);
  const lookup = await getArtifactIfPresent(
    artifactClient,
    runId,
    owner,
    repo,
    githubToken,
  );
  if (!lookup) return;
  try {
    await verifySourceJobs(readOctokit, owner, repo, runId);
  } catch (error) {
    if (!(error instanceof IneligibleSourceJobsError)) throw error;
    core.info(`${error.message}; nothing to apply.`);
    return;
  }
  const download = await artifactClient.downloadArtifact(lookup.artifact.id, {
      findBy: {
        token: githubToken,
        workflowRunId: runId,
        repositoryOwner: owner,
        repositoryName: repo,
      },
    });
  if (!download.downloadPath) throw new Error("artifact download path is missing");
  const artifactPath = join(download.downloadPath, "prek-autofix.json");
  const rawLimit = maximumRawArtifactBytes(maxBytes, maxFiles);
  const fileStat = await stat(artifactPath);
  if (fileStat.size > rawLimit) throw new Error("artifact JSON is too large");
  const raw = await readFile(artifactPath, "utf8");
  if (Buffer.byteLength(raw) > rawLimit) throw new Error("artifact JSON is too large");
  const artifact = parseChangeArtifact(JSON.parse(raw), maxFiles, maxBytes);

  const pat = core.getInput("autofix-token", { required: true });
  core.setSecret(pat);
  const patOctokit = github.getOctokit(pat);
  const read = createReadClient(readOctokit, owner, repo);
  const mutation = createMutationClient(patOctokit);
  await applyArtifact(read, mutation, {
    baseRepository, runId, artifact,
    artifactUrl:
      `${github.context.serverUrl}/${baseRepository}/actions/runs/${runId}/artifacts/${lookup.artifact.id}`,
    sourceRunUrl: `${github.context.serverUrl}/${baseRepository}/actions/runs/${runId}`,
    sourceWorkflow, commitMessage,
  });
}

void run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
