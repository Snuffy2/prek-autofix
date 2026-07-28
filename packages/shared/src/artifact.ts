import { posix as path } from "node:path";

export const ARTIFACT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MAX_FILES = 100;
export const DEFAULT_MAX_BYTES = 10_485_760;
export const MAX_PATH_BYTES = 4_096;
export const MAX_SOURCE_STRING_BYTES = 255;
export const DEFAULT_COMMIT_MESSAGE =
  "[prek-autofix] apply automatic fixes";
export const COMMENT_MARKER = "<!-- prek-autofix-result -->";

export type FileOperationKind = "add" | "modify" | "delete";

export interface FileOperation {
  path: string;
  operation: FileOperationKind;
  mode: string;
  content?: string;
}

export interface ArtifactSource {
  runId: number;
  repository: string;
  workflow: string;
  event: "pull_request";
  pullRequestNumber: number;
  headSha: string;
}

export interface ChangeArtifact {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  source: ArtifactSource;
  operations: FileOperation[];
}

export class ArtifactValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeRepositoryPath(candidate: string): boolean {
  if (
    candidate.length === 0 ||
    Buffer.byteLength(candidate) > MAX_PATH_BYTES ||
    candidate.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(candidate) ||
    candidate.includes("\\") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/.test(candidate)
  ) {
    return false;
  }

  const normalized = path.normalize(candidate);
  return (
    normalized === candidate &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

export function isWorkflowPath(candidate: string): boolean {
  return (
    candidate === ".github/workflows" ||
    candidate.startsWith(".github/workflows/")
  );
}

function parseSource(value: unknown): ArtifactSource {
  if (!isRecord(value)) {
    throw new ArtifactValidationError("artifact source must be an object");
  }

  const { runId, repository, workflow, event, pullRequestNumber, headSha } =
    value;
  if (!Number.isSafeInteger(runId) || (runId as number) <= 0) {
    throw new ArtifactValidationError("source runId must be a positive integer");
  }
  if (
    typeof repository !== "string" ||
    Buffer.byteLength(repository) > MAX_SOURCE_STRING_BYTES ||
    /[\u0000-\u001f\u007f]/.test(repository) ||
    !/^[^/\s]+\/[^/\s]+$/.test(repository)
  ) {
    throw new ArtifactValidationError(
      "source repository must have owner/name form",
    );
  }
  if (
    typeof workflow !== "string" ||
    workflow.length === 0 ||
    Buffer.byteLength(workflow) > MAX_SOURCE_STRING_BYTES ||
    /[\u0000-\u001f\u007f]/.test(workflow)
  ) {
    throw new ArtifactValidationError("source workflow must be non-empty");
  }
  if (event !== "pull_request") {
    throw new ArtifactValidationError("source event must be pull_request");
  }
  if (
    !Number.isSafeInteger(pullRequestNumber) ||
    (pullRequestNumber as number) <= 0
  ) {
    throw new ArtifactValidationError(
      "source pullRequestNumber must be a positive integer",
    );
  }
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new ArtifactValidationError("source headSha must be a full SHA");
  }

  return {
    runId: runId as number,
    repository,
    workflow,
    event,
    pullRequestNumber: pullRequestNumber as number,
    headSha,
  };
}

function parseOperation(value: unknown): FileOperation {
  if (!isRecord(value)) {
    throw new ArtifactValidationError("file operation must be an object");
  }
  const { path: filePath, operation, mode, content } = value;
  if (typeof filePath !== "string" || !isSafeRepositoryPath(filePath)) {
    throw new ArtifactValidationError(`unsafe artifact path: ${String(filePath)}`);
  }
  if (isWorkflowPath(filePath)) {
    throw new ArtifactValidationError(
      `workflow files cannot be applied automatically: ${filePath}`,
    );
  }
  if (
    operation !== "add" &&
    operation !== "modify" &&
    operation !== "delete"
  ) {
    throw new ArtifactValidationError(`invalid operation for ${filePath}`);
  }
  if (mode !== "100644" && mode !== "100755") {
    throw new ArtifactValidationError(`invalid mode for ${filePath}`);
  }
  if (operation === "delete") {
    if (content !== undefined) {
      throw new ArtifactValidationError(
        `delete operation must not include content: ${filePath}`,
      );
    }
  } else if (typeof content !== "string") {
    throw new ArtifactValidationError(
      `non-delete operation must include base64 content: ${filePath}`,
    );
  }

  return {
    path: filePath,
    operation,
    mode,
    ...(content === undefined ? {} : { content }),
  };
}

export function parseChangeArtifact(
  value: unknown,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
): ChangeArtifact {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) {
    throw new ArtifactValidationError(
      "maximum file count must be a nonnegative safe integer",
    );
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ArtifactValidationError(
      "maximum byte count must be a nonnegative safe integer",
    );
  }
  if (!isRecord(value)) {
    throw new ArtifactValidationError("artifact must be an object");
  }
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new ArtifactValidationError(
      `unsupported artifact schema version: ${String(value.schemaVersion)}`,
    );
  }
  if (!Array.isArray(value.operations)) {
    throw new ArtifactValidationError("artifact operations must be an array");
  }
  if (value.operations.length > maxFiles) {
    throw new ArtifactValidationError(
      `artifact has ${value.operations.length} files; maximum is ${maxFiles}`,
    );
  }

  const operations = value.operations.map(parseOperation);
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const operation of operations) {
    if (seen.has(operation.path)) {
      throw new ArtifactValidationError(
        `artifact contains duplicate path: ${operation.path}`,
      );
    }
    seen.add(operation.path);
    if (operation.content !== undefined) {
      const remainingBytes = maxBytes - totalBytes;
      const maximumEncodedLength = Math.ceil(remainingBytes / 3) * 4;
      if (operation.content.length > maximumEncodedLength) {
        throw new ArtifactValidationError(
          `artifact content exceeds maximum of ${maxBytes} bytes`,
        );
      }
      const content = Buffer.from(operation.content, "base64");
      if (content.toString("base64") !== operation.content) {
        throw new ArtifactValidationError(
          `invalid base64 content: ${operation.path}`,
        );
      }
      totalBytes += content.byteLength;
      if (totalBytes > maxBytes) {
        throw new ArtifactValidationError(
          `artifact content exceeds maximum of ${maxBytes} bytes`,
        );
      }
    }
  }
  const sortedPaths = [...seen].sort();
  for (let index = 1; index < sortedPaths.length; index += 1) {
    const previous = sortedPaths[index - 1];
    const current = sortedPaths[index];
    if (previous !== undefined && current?.startsWith(`${previous}/`)) {
      throw new ArtifactValidationError(
        `artifact contains conflicting paths: ${previous} and ${current}`,
      );
    }
  }

  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    source: parseSource(value.source),
    operations,
  };
}

export function artifactName(runId: number): string {
  return `prek-autofix-${runId}`;
}
