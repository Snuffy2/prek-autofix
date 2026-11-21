import type { ChangeArtifact, FileOperation } from "../../shared/src/artifact";

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

type ApplyFailure =
  | {
      kind:
        | "stale-head"
        | "fork-token-required"
        | "fork-owner-ineligible"
        | "fork-edits-disabled"
        | "source-ineligible"
        | "source-changed"
        | "fork-edits-revoked";
    }
  | {
      kind: "mutation-rejected";
      status: number | undefined;
      usedGithubTokenFallback: boolean;
    };

export class ApplyOutcomeError extends Error {
  public constructor(public readonly outcome: ApplyFailure) {
    super(outcome.kind);
    this.name = "ApplyOutcomeError";
  }
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

export interface ApplyRequest {
  baseRepository: string;
  runId: number;
  runAttempt: number;
  artifact: ChangeArtifact;
  sourceWorkflow: string;
  commitMessage: string;
  mutationTokenUsedGithubFallback: boolean;
  source?: ResolvedSource;
}

export interface ApplyResult {
  pullRequestNumber: number;
  commitSha: string;
}

export interface ResolvedSource {
  run: WorkflowRun;
  pullRequest: PullRequest;
}

export interface ResolveSourceRequest {
  baseRepository: string;
  runId: number;
  sourceWorkflow: string;
}

/** Resolve the trusted source run and its single associated open pull request. */
export async function resolveSourcePullRequest(
  read: ReadClient,
  request: ResolveSourceRequest,
): Promise<ResolvedSource> {
  repositoryParts(request.baseRepository);
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
  const pullRequest = candidates[0]!;
  if (pullRequest.headRepositoryNodeId.length === 0) {
    throw new ApplyError("pull request head repository identity is missing");
  }
  return { run, pullRequest };
}

async function revalidateSourcePullRequest(
  read: ReadClient,
  request: ResolveSourceRequest,
  expected: ResolvedSource,
): Promise<void> {
  let current: ResolvedSource;
  try {
    current = await resolveSourcePullRequest(read, request);
  } catch {
    throw new ApplyOutcomeError({ kind: "source-ineligible" });
  }

  const { run, pullRequest } = current;
  const expectedRun = expected.run;
  const expectedPullRequest = expected.pullRequest;
  if (pullRequest.headSha !== expectedPullRequest.headSha) {
    throw new ApplyOutcomeError({ kind: "stale-head" });
  }
  if (
    run.id !== expectedRun.id ||
    run.name !== expectedRun.name ||
    run.event !== expectedRun.event ||
    run.headSha !== expectedRun.headSha ||
    run.headBranch !== expectedRun.headBranch ||
    run.headRepository !== expectedRun.headRepository ||
    pullRequest.number !== expectedPullRequest.number ||
    pullRequest.state !== "open" ||
    pullRequest.baseRepository !== expectedPullRequest.baseRepository ||
    pullRequest.headRepository !== expectedPullRequest.headRepository ||
    pullRequest.headRepositoryNodeId !==
      expectedPullRequest.headRepositoryNodeId ||
    pullRequest.headRepositoryOwnerType !==
      expectedPullRequest.headRepositoryOwnerType ||
    pullRequest.headRef !== expectedPullRequest.headRef
  ) {
    throw new ApplyOutcomeError({ kind: "source-changed" });
  }

  if (
    pullRequest.headRepository !== request.baseRepository &&
    !(await read.getMaintainerCanModify(pullRequest.number))
  ) {
    throw new ApplyOutcomeError({ kind: "fork-edits-revoked" });
  }
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
  const source =
    request.source ??
    (await resolveSourcePullRequest(read, {
      baseRepository: request.baseRepository,
      runId: request.runId,
      sourceWorkflow: request.sourceWorkflow,
    }));
  const { run, pullRequest: pr } = source;

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
  if (pr.headSha !== run.headSha) {
    throw new ApplyOutcomeError({ kind: "stale-head" });
  }
  if (!sameRepository && request.mutationTokenUsedGithubFallback) {
    throw new ApplyOutcomeError({ kind: "fork-token-required" });
  }
  if (!sameRepository && pr.headRepositoryOwnerType !== "User") {
    throw new ApplyOutcomeError({ kind: "fork-owner-ineligible" });
  }
  if (!sameRepository && !(await read.getMaintainerCanModify(pr.number))) {
    throw new ApplyOutcomeError({ kind: "fork-edits-disabled" });
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
    await revalidateSourcePullRequest(
      read,
      {
        baseRepository: request.baseRepository,
        runId: request.runId,
        sourceWorkflow: request.sourceWorkflow,
      },
      source,
    );
    await mutation.updateRef(
      pr.headRepositoryNodeId,
      `refs/heads/${pr.headRef}`,
      commit,
      run.headSha,
    );
  } catch (error) {
    if (error instanceof ApplyOutcomeError) throw error;
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : undefined;
    throw new ApplyOutcomeError({
      kind: "mutation-rejected",
      status,
      usedGithubTokenFallback: request.mutationTokenUsedGithubFallback,
    });
  }
  return { pullRequestNumber: pr.number, commitSha: commit };
}
