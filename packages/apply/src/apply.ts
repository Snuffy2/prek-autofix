import {
  COMMENT_MARKER,
  type ChangeArtifact,
  type FileOperation,
} from "../../shared/src/artifact";

export interface WorkflowRun {
  id: number;
  name: string;
  event: string;
  headSha: string;
  headBranch: string;
  headRepository: string;
}

export interface PullRequest {
  number: number;
  state: string;
  baseRepository: string;
  headRepository: string;
  headRepositoryNodeId: string;
  headRepositoryOwnerType: string;
  headRef: string;
  headSha: string;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
}

export interface ExistingComment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
}

export interface ReadClient {
  getWorkflowRun(runId: number): Promise<WorkflowRun>;
  listAssociatedPullRequests(sha: string): Promise<PullRequest[]>;
  getMaintainerCanModify(prNumber: number): Promise<boolean>;
  getCommitTreeSha(repository: string, sha: string): Promise<string>;
  getTreeEntries(
    repository: string,
    treeSha: string,
    paths: string[],
  ): Promise<TreeEntry[]>;
  upsertComment(prNumber: number, body: string): Promise<void>;
  markCommentObsolete(prNumber: number): Promise<void>;
  resolveComment(prNumber: number): Promise<void>;
}

export interface MutationClient {
  createBlob(repository: string, content: string): Promise<string>;
  createTree(
    repository: string,
    baseTree: string,
    entries: MutationTreeEntry[],
  ): Promise<string>;
  createCommit(
    repository: string,
    message: string,
    tree: string,
    parent: string,
  ): Promise<string>;
  updateRef(
    repositoryNodeId: string,
    ref: string,
    sha: string,
    expectedSha: string,
  ): Promise<void>;
}

export interface MutationTreeEntry {
  path: string;
  mode: "100644" | "100755";
  type: "blob";
  sha: string | null;
}

export class ApplyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ApplyError";
  }
}

export function ownMarkerCommentIds(comments: ExistingComment[]): number[] {
  return comments
    .filter(
      (comment) =>
        comment.user?.login === "github-actions[bot]" &&
        comment.body?.includes(COMMENT_MARKER),
    )
    .map((comment) => comment.id)
    .sort((left, right) => left - right);
}

export function maximumRawArtifactBytes(
  maxBytes: number,
  maxFiles: number,
): number {
  const encodedContent = maxBytes * 2;
  const operationOverhead = maxFiles * 8_192;
  if (
    !Number.isSafeInteger(encodedContent) ||
    !Number.isSafeInteger(operationOverhead) ||
    encodedContent > Number.MAX_SAFE_INTEGER - operationOverhead
  ) {
    throw new ApplyError(
      "configured limits are too large to safely bound artifact JSON",
    );
  }
  return Math.max(65_536, encodedContent + operationOverhead);
}

function repositoryParts(repository: string): [string, string] {
  const parts = repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ApplyError(`invalid repository: ${repository}`);
  }
  return [parts[0], parts[1]];
}

function validateOperationAgainstTree(
  operation: FileOperation,
  entries: Map<string, TreeEntry>,
): void {
  const segments = operation.path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = entries.get(segments.slice(0, index).join("/"));
    if (
      ancestor !== undefined &&
      (ancestor.type !== "tree" || ancestor.mode !== "040000")
    ) {
      throw new ApplyError(
        `operation traverses a non-directory tree entry: ${operation.path}`,
      );
    }
  }
  const existing = entries.get(operation.path);
  if (operation.operation === "add") {
    if (existing !== undefined) {
      throw new ApplyError(`add target already exists: ${operation.path}`);
    }
    return;
  }
  if (
    existing === undefined ||
    existing.type !== "blob" ||
    (existing.mode !== "100644" && existing.mode !== "100755")
  ) {
    throw new ApplyError(
      `${operation.operation} target is not an existing regular file: ${operation.path}`,
    );
  }
}

function recoveryComment(
  reason: string,
  artifactUrl: string,
  sourceRunUrl: string,
): string {
  return `${COMMENT_MARKER}
prek-autofix could not apply the generated changes: **${reason}**

[Download the generated artifact](${artifactUrl}) or [inspect the source run](${sourceRunUrl}). Apply the fixes locally, push them to the pull request branch, and rerun the checks.`;
}

export interface ApplyRequest {
  baseRepository: string;
  runId: number;
  runAttempt: number;
  artifact: ChangeArtifact;
  artifactUrl: string;
  sourceRunUrl: string;
  sourceWorkflow: string;
  commitMessage: string;
}

export interface ApplyResult {
  pullRequestNumber: number;
  commitSha: string;
}

export async function applyArtifact(
  read: ReadClient,
  mutation: MutationClient,
  request: ApplyRequest,
): Promise<ApplyResult> {
  repositoryParts(request.baseRepository);
  if (request.artifact.operations.length === 0) {
    throw new ApplyError("artifact contains no file operations");
  }
  const run = await read.getWorkflowRun(request.runId);
  if (
    run.id !== request.runId ||
    run.name !== request.sourceWorkflow ||
    run.event !== "pull_request"
  ) {
    throw new ApplyError("source workflow run name or event is not eligible");
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
    throw new ApplyError(
      `expected exactly one associated open pull request; found ${candidates.length}`,
    );
  }
  const pr = candidates[0]!;
  if (pr.headRepositoryNodeId.length === 0) {
    throw new ApplyError("pull request head repository identity is missing");
  }

  const claims = request.artifact.source;
  if (
    claims.runId !== run.id ||
    claims.runAttempt !== request.runAttempt ||
    claims.repository !== request.baseRepository ||
    claims.workflow !== run.name ||
    claims.event !== "pull_request" ||
    claims.pullRequestNumber !== pr.number ||
    claims.headSha !== run.headSha
  ) {
    throw new ApplyError(
      "artifact source claims do not match the workflow run",
    );
  }
  const sameRepository = pr.headRepository === request.baseRepository;
  if (!sameRepository && pr.headRepositoryOwnerType !== "User") {
    const reason = "only user-owned forks are eligible";
    await read.upsertComment(
      pr.number,
      recoveryComment(reason, request.artifactUrl, request.sourceRunUrl),
    );
    throw new ApplyError(reason);
  }
  if (!sameRepository && !(await read.getMaintainerCanModify(pr.number))) {
    const reason = "the fork does not allow maintainer edits";
    await read.upsertComment(
      pr.number,
      recoveryComment(reason, request.artifactUrl, request.sourceRunUrl),
    );
    throw new ApplyError(reason);
  }
  if (pr.headSha !== run.headSha) {
    const reason = "the pull request head changed after collection";
    await read.markCommentObsolete(pr.number);
    throw new ApplyError(reason);
  }

  const baseTree = await read.getCommitTreeSha(
    request.baseRepository,
    run.headSha,
  );
  const sourceTree = await read.getTreeEntries(
    request.baseRepository,
    baseTree,
    request.artifact.operations.map((operation) => operation.path),
  );
  const byPath = new Map(sourceTree.map((entry) => [entry.path, entry]));
  for (const operation of request.artifact.operations) {
    validateOperationAgainstTree(operation, byPath);
  }

  let commit: string;
  try {
    const treeEntries: MutationTreeEntry[] = [];
    for (const operation of request.artifact.operations) {
      let sha: string | null = null;
      if (operation.operation !== "delete") {
        sha = await mutation.createBlob(pr.headRepository, operation.content!);
      }
      treeEntries.push({
        path: operation.path,
        mode: operation.mode as "100644" | "100755",
        type: "blob",
        sha,
      });
    }
    const tree = await mutation.createTree(
      pr.headRepository,
      baseTree,
      treeEntries,
    );
    commit = await mutation.createCommit(
      pr.headRepository,
      request.commitMessage,
      tree,
      run.headSha,
    );
    await mutation.updateRef(
      pr.headRepositoryNodeId,
      `refs/heads/${pr.headRef}`,
      commit,
      run.headSha,
    );
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : undefined;
    const reason =
      status === 409 || status === 422
        ? "the branch changed or GitHub rejected the non-forced update"
        : "GitHub rejected the fix commit";
    await read.upsertComment(
      pr.number,
      recoveryComment(reason, request.artifactUrl, request.sourceRunUrl),
    );
    throw new ApplyError(reason);
  }
  try {
    await read.resolveComment(pr.number);
  } catch {
    // The branch update already succeeded. Marker cleanup is best-effort so a
    // transient comment failure cannot invite a misleading mutation retry.
  }
  return { pullRequestNumber: pr.number, commitSha: commit };
}
