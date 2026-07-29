import type { getOctokit } from "@actions/github";
import {
  COMMENT_MARKER,
  validatePathComponentBudget,
} from "../../shared/src/artifact";
import {
  ownMarkerCommentIds,
  type MutationClient,
  type PullRequest,
  type ReadClient,
  type TreeEntry,
  type WorkflowRun,
} from "./apply";

type Octokit = ReturnType<typeof getOctokit>;
type AssociatedPullRequest = Awaited<
  ReturnType<Octokit["rest"]["repos"]["listPullRequestsAssociatedWithCommit"]>
>["data"][number];

interface GitTreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string | null;
}

function repositoryParts(repository: string): [string, string] {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra !== undefined) {
    throw new Error("invalid repository");
  }
  return [owner, repo];
}

export function createReadClient(
  octokit: Octokit,
  owner: string,
  repo: string,
): ReadClient {
  const reconcileMarkerComments = async (
    prNumber: number,
    body: string,
    createWhenAbsent: boolean,
  ): Promise<void> => {
    const comments = await octokit.paginate(
      octokit.rest.issues.listComments,
      { owner, repo, issue_number: prNumber, per_page: 100 },
    );
    const [canonicalId, ...duplicateIds] = ownMarkerCommentIds(comments);
    if (canonicalId === undefined) {
      if (createWhenAbsent) {
        await octokit.rest.issues.createComment({
          owner, repo, issue_number: prNumber, body,
        });
      }
      return;
    }
    for (const duplicateId of duplicateIds) {
      await octokit.rest.issues.deleteComment({
        owner, repo, comment_id: duplicateId,
      });
    }
    await octokit.rest.issues.updateComment({
      owner, repo, comment_id: canonicalId, body,
    });
  };

  return {
    async getWorkflowRun(id): Promise<WorkflowRun> {
      const { data } = await octokit.rest.actions.getWorkflowRun({
        owner, repo, run_id: id,
      });
      return {
        id: data.id,
        name: data.name ?? "",
        event: data.event,
        headSha: data.head_sha,
        headBranch: data.head_branch ?? "",
        headRepository: data.head_repository?.full_name ?? "",
      };
    },
    async listAssociatedPullRequests(sha): Promise<PullRequest[]> {
      const associated = await octokit.paginate(
        octokit.rest.repos.listPullRequestsAssociatedWithCommit,
        { owner, repo, commit_sha: sha, per_page: 100 },
      );
      return associated.map((pr: AssociatedPullRequest) => ({
        number: pr.number,
        state: pr.state,
        baseRepository: pr.base.repo.full_name,
        headRepository: pr.head.repo?.full_name ?? "",
        headRepositoryNodeId: pr.head.repo?.node_id ?? "",
        headRepositoryOwnerType: pr.head.repo?.owner.type ?? "",
        headRef: pr.head.ref,
        headSha: pr.head.sha,
      }));
    },
    async getMaintainerCanModify(prNumber) {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return data.maintainer_can_modify ?? false;
    },
    async getCommitTreeSha(repository, sha) {
      const [targetOwner, targetRepo] = repositoryParts(repository);
      const { data } = await octokit.rest.git.getCommit({
        owner: targetOwner, repo: targetRepo, commit_sha: sha,
      });
      return data.tree.sha;
    },
    async getTreeEntries(repository, rootTreeSha, paths) {
      validatePathComponentBudget(paths);
      const [targetOwner, targetRepo] = repositoryParts(repository);
      const cache = new Map<string, GitTreeEntry[]>();
      const loadTree = async (sha: string) => {
        const cached = cache.get(sha);
        if (cached !== undefined) return cached;
        const { data } = await octokit.rest.git.getTree({
          owner: targetOwner,
          repo: targetRepo,
          tree_sha: sha,
        });
        if (data.truncated) {
          throw new Error("non-recursive source tree response was truncated");
        }
        const entries: GitTreeEntry[] = data.tree;
        cache.set(sha, entries);
        return entries;
      };
      const found = new Map<string, TreeEntry>();
      for (const path of new Set(paths)) {
        const segments = path.split("/");
        let treeSha = rootTreeSha;
        let prefix = "";
        for (const segment of segments) {
          const entries = await loadTree(treeSha);
          const entry = entries.find((candidate) => candidate.path === segment);
          if (!entry?.path || !entry.mode || !entry.type) break;
          const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
          found.set(fullPath, {
            path: fullPath,
            mode: entry.mode,
            type: entry.type,
          });
          prefix = fullPath;
          if (entry.type !== "tree" || !entry.sha) break;
          treeSha = entry.sha;
        }
      }
      return [...found.values()];
    },
    async upsertComment(prNumber, body) {
      await reconcileMarkerComments(prNumber, body, true);
    },
    async markCommentObsolete(prNumber) {
      await reconcileMarkerComments(
        prNumber,
        `${COMMENT_MARKER}
This prek-autofix apply run is obsolete because the pull request branch has advanced. No action is required for this generated artifact.`,
        false,
      );
    },
    async resolveComment(prNumber) {
      await reconcileMarkerComments(
        prNumber,
        `${COMMENT_MARKER}\nprek-autofix applied the generated changes successfully.`,
        false,
      );
    },
  };
}

export function createMutationClient(octokit: Octokit): MutationClient {
  return {
    async createBlob(repository, content) {
      const [owner, repo] = repositoryParts(repository);
      const { data } = await octokit.rest.git.createBlob({
        owner, repo, content, encoding: "base64",
      });
      return data.sha;
    },
    async createTree(repository, baseTree, tree) {
      const [owner, repo] = repositoryParts(repository);
      const { data } = await octokit.rest.git.createTree({
        owner, repo, base_tree: baseTree, tree,
      });
      return data.sha;
    },
    async createCommit(repository, message, tree, parent) {
      const [owner, repo] = repositoryParts(repository);
      const { data } = await octokit.rest.git.createCommit({
        owner, repo, message, tree, parents: [parent],
      });
      return data.sha;
    },
    async updateRef(repositoryId, ref, sha, expectedSha) {
      await octokit.graphql(
        `mutation UpdatePrekAutofixRef($input: UpdateRefsInput!) {
          updateRefs(input: $input) { clientMutationId }
        }`,
        {
          input: {
            repositoryId,
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
}
