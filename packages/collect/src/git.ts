import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  isSafeRepositoryPath,
  type ChangeArtifact,
  type FileOperation,
} from "../../shared/src/artifact";

export const GIT_CAPTURE_LIMIT_BYTES = DEFAULT_MAX_BYTES;

export interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type Execute = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    streamUntrustedOutput?: boolean;
    streamLimitBytes?: number;
    captureLimitBytes?: number;
    timeoutMs?: number;
  },
) => Promise<CommandResult>;

function fields(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter(Boolean);
}

export function operationForGitStatus(
  status: string,
): FileOperation["operation"] {
  if (status === "A") return "add";
  if (status === "M") return "modify";
  if (status === "D") return "delete";
  throw new Error(`unsupported git diff status: ${status}`);
}

export async function assertExactCleanCheckout(
  root: string,
  expectedSha: string,
  execute: Execute,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const head = await execute("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env,
    captureLimitBytes: GIT_CAPTURE_LIMIT_BYTES,
  });
  if (head.exitCode !== 0 || head.stdout.toString("utf8").trim() !== expectedSha) {
    throw new Error("checkout HEAD does not match pull request head SHA");
  }
  const status = await execute("git", ["status", "--porcelain=v1", "-z"], {
    cwd: root,
    env,
    captureLimitBytes: GIT_CAPTURE_LIMIT_BYTES,
  });
  if (status.exitCode !== 0) throw new Error("could not inspect checkout status");
  if (status.stdout.length !== 0) throw new Error("initial checkout is not clean");
}

async function trackedModes(
  root: string,
  paths: string[],
  execute: Execute,
  env: NodeJS.ProcessEnv,
): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const result = await execute(
    "git",
    ["ls-tree", "-z", "HEAD", "--", ...paths],
    {
      cwd: root,
      env,
      captureLimitBytes: GIT_CAPTURE_LIMIT_BYTES,
    },
  );
  if (result.exitCode !== 0) throw new Error("could not inspect tracked files");
  const modes = new Map<string, string>();
  for (const record of fields(result.stdout)) {
    const match = /^(\d{6})\s+\w+\s+[0-9a-f]+\t(.+)$/.exec(record);
    if (match?.[1] && match[2]) modes.set(match[2], match[1]);
  }
  return modes;
}

function safeFile(root: string, file: string): string {
  if (!isSafeRepositoryPath(file)) {
    throw new Error(`unsafe changed path: ${file}`);
  }
  const absolute = resolve(root, file);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`unsafe changed path: ${file}`);
  }
  return absolute;
}

async function readStableFile(
  absolute: string,
  path: string,
  remainingBytes: number,
): Promise<{ content: Buffer; mode: "100644" | "100755" }> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error(`unsupported changed file type: ${path}`);
    }
    if (before.size > BigInt(remainingBytes)) {
      throw new Error("content limit exceeded");
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      content.byteLength > remainingBytes ||
      BigInt(content.byteLength) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error("changed file was modified while being collected");
    }
    return {
      content,
      mode: before.mode & 0o111n ? "100755" : "100644",
    };
  } finally {
    await handle.close();
  }
}

export async function collectOperations(
  root: string,
  execute: Execute,
  env: NodeJS.ProcessEnv,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<FileOperation[]> {
  const [diff, untracked] = await Promise.all([
    execute(
      "git",
      ["diff", "--name-status", "-z", "--no-renames", "HEAD", "--"],
      { cwd: root, env, captureLimitBytes: GIT_CAPTURE_LIMIT_BYTES },
    ),
    execute("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      env,
      captureLimitBytes: GIT_CAPTURE_LIMIT_BYTES,
    }),
  ]);
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) {
    throw new Error("could not inspect changes");
  }

  const changes = fields(diff.stdout);
  const entries: Array<{ operation: FileOperation["operation"]; path: string }> =
    [];
  for (let index = 0; index < changes.length; index += 2) {
    const status = changes[index];
    const file = changes[index + 1];
    if (!status || !file) throw new Error("unexpected git diff output");
    entries.push({
      operation: operationForGitStatus(status),
      path: file,
    });
  }
  for (const file of fields(untracked.stdout)) {
    entries.push({ operation: "add", path: file });
  }
  if (entries.length > maxFiles) {
    throw new Error(
      `collected ${entries.length} files; maximum is ${maxFiles}`,
    );
  }
  for (const { path } of entries) safeFile(root, path);

  const originalModes = await trackedModes(
    root,
    entries
      .filter(({ operation }) => operation === "delete")
      .map(({ path }) => path),
    execute,
    env,
  );
  const operations: FileOperation[] = [];
  let totalBytes = 0;
  for (const { operation, path } of entries) {
    if (operation === "delete") {
      operations.push({
        path,
        operation,
        mode: originalModes.get(path) ?? "100644",
      });
      continue;
    }
    const absolute = safeFile(root, path);
    let file: Awaited<ReturnType<typeof readStableFile>>;
    try {
      file = await readStableFile(absolute, path, maxBytes - totalBytes);
    } catch (error) {
      if ((error as Error).message !== "content limit exceeded") throw error;
      throw new Error(`collected content exceeds maximum of ${maxBytes} bytes`);
    }
    totalBytes += file.content.byteLength;
    operations.push({
      path,
      operation,
      mode: file.mode,
      content: file.content.toString("base64"),
    });
  }
  return operations.sort((left, right) => left.path.localeCompare(right.path));
}

export async function writeArtifact(
  root: string,
  artifact: ChangeArtifact,
): Promise<string> {
  const output = join(root, "prek-autofix.json");
  await writeFile(output, `${JSON.stringify(artifact, undefined, 2)}\n`, {
    mode: 0o600,
  });
  return output;
}
