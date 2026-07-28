import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactName,
  DEFAULT_COMMIT_MESSAGE,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  parseChangeArtifact,
} from "../../shared/src/artifact";
import {
  applyArtifact,
  maximumRawArtifactBytes,
  ownMarkerCommentId,
  type MutationClient,
  type PullRequest,
  type ReadClient,
  type TreeEntry,
  type WorkflowRun,
} from "./apply";

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
  const pat = core.getInput("autofix-token", { required: true });
  core.setSecret(pat);
  const maxFiles = positiveInput("max-files", DEFAULT_MAX_FILES);
  const maxBytes = positiveInput("max-bytes", DEFAULT_MAX_BYTES);
  const sourceWorkflow = core.getInput("source-workflow") || "prek-autofix";
  const commitMessage =
    core.getInput("commit-message") || DEFAULT_COMMIT_MESSAGE;

  const artifactClient = new DefaultArtifactClient();
  const lookup = await artifactClient.getArtifact(artifactName(runId), {
    findBy: {
      token: githubToken,
      workflowRunId: runId,
      repositoryOwner: owner,
      repositoryName: repo,
    },
  });
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

  const readOctokit = github.getOctokit(githubToken);
  const patOctokit = github.getOctokit(pat);
  const read: ReadClient = {
    async getWorkflowRun(id): Promise<WorkflowRun> {
      const { data } = await readOctokit.rest.actions.getWorkflowRun({
        owner, repo, run_id: id,
      });
      return {
        id: data.id, name: data.name ?? "", event: data.event,
        headSha: data.head_sha, headBranch: data.head_branch ?? "",
        headRepository: data.head_repository?.full_name ?? "",
      };
    },
    async listAssociatedPullRequests(sha): Promise<PullRequest[]> {
      const { data } =
        await readOctokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner, repo, commit_sha: sha,
        });
      return data.map((pr: (typeof data)[number]) => ({
        number: pr.number, state: pr.state, htmlUrl: pr.html_url,
        baseRepository: pr.base.repo.full_name,
        headRepository: pr.head.repo?.full_name ?? "",
        headRepositoryNodeId: pr.head.repo?.node_id ?? "",
        headRepositoryOwnerType: pr.head.repo?.owner.type ?? "",
        headRef: pr.head.ref, headSha: pr.head.sha,
        maintainerCanModify: pr.maintainer_can_modify ?? false,
      }));
    },
    async getCommitTreeSha(repository, sha) {
      const [targetOwner, targetRepo] = repository.split("/") as [string, string];
      const { data } = await readOctokit.rest.git.getCommit({
        owner: targetOwner, repo: targetRepo, commit_sha: sha,
      });
      return data.tree.sha;
    },
    async getTree(repository, treeSha): Promise<TreeEntry[]> {
      const [targetOwner, targetRepo] = repository.split("/") as [string, string];
      const { data } = await readOctokit.rest.git.getTree({
        owner: targetOwner, repo: targetRepo, tree_sha: treeSha, recursive: "true",
      });
      if (data.truncated) throw new Error("source tree response was truncated");
      return data.tree.flatMap((entry: (typeof data.tree)[number]) =>
        entry.path && entry.mode && entry.type
          ? [{ path: entry.path, mode: entry.mode, type: entry.type }]
          : [],
      );
    },
    async upsertComment(prNumber, body) {
      const comments = await readOctokit.paginate(
        readOctokit.rest.issues.listComments,
        { owner, repo, issue_number: prNumber, per_page: 100 },
      );
      const existingId = ownMarkerCommentId(comments);
      if (existingId !== undefined) {
        await readOctokit.rest.issues.updateComment({
          owner, repo, comment_id: existingId, body,
        });
      } else {
        await readOctokit.rest.issues.createComment({
          owner, repo, issue_number: prNumber, body,
        });
      }
    },
  };
  const mutation: MutationClient = {
    async createBlob(repository, content) {
      const [targetOwner, targetRepo] = repository.split("/") as [string, string];
      const { data } = await patOctokit.rest.git.createBlob({
        owner: targetOwner, repo: targetRepo, content, encoding: "base64",
      });
      return data.sha;
    },
    async createTree(repository, baseTree, tree) {
      const [targetOwner, targetRepo] = repository.split("/") as [string, string];
      const { data } = await patOctokit.rest.git.createTree({
        owner: targetOwner, repo: targetRepo, base_tree: baseTree, tree,
      });
      return data.sha;
    },
    async createCommit(repository, message, tree, parent) {
      const [targetOwner, targetRepo] = repository.split("/") as [string, string];
      const { data } = await patOctokit.rest.git.createCommit({
        owner: targetOwner, repo: targetRepo, message, tree, parents: [parent],
      });
      return data.sha;
    },
    async updateRef(repositoryNodeId, ref, sha, expectedSha) {
      await patOctokit.graphql(
        `mutation UpdatePrekAutofixRef($input: UpdateRefsInput!) {
          updateRefs(input: $input) { clientMutationId }
        }`,
        {
          input: {
            repositoryId: repositoryNodeId,
            refUpdates: [
              {
                name: ref,
                beforeOid: expectedSha,
                afterOid: sha,
                force: false,
              },
            ],
          },
        },
      );
    },
  };
  await applyArtifact(read, mutation, {
    baseRepository, runId, artifact,
    artifactUrl: `${github.context.serverUrl}/${baseRepository}/actions/runs/${runId}/artifacts`,
    sourceRunUrl: `${github.context.serverUrl}/${baseRepository}/actions/runs/${runId}`,
    sourceWorkflow, commitMessage,
  });
}

void run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
