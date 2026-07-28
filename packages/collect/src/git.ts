import { writeFile } from "node:fs/promises";
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
    cleanupProcessGroup?: boolean;
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

const SECURE_READ_SCRIPT = String.raw`
import os, stat, sys, time
root, path, maximum, delay_ms = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
flags = os.O_RDONLY | os.O_NOFOLLOW
directory_flags = flags | os.O_DIRECTORY
fd = os.open(root, directory_flags)
try:
    parts = path.split("/")
    for component in parts[:-1]:
        child = os.open(component, directory_flags, dir_fd=fd)
        os.close(fd)
        fd = child
        if delay_ms:
            time.sleep(delay_ms / 1000)
    file_fd = os.open(parts[-1], flags, dir_fd=fd)
    try:
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError("unsupported changed file type")
        if before.st_size > maximum:
            raise RuntimeError("content limit exceeded")
        chunks, total = [], 0
        while True:
            chunk = os.read(file_fd, min(65536, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                raise RuntimeError("content limit exceeded")
        after = os.fstat(file_fd)
        stable = ("st_size", "st_mtime_ns", "st_ctime_ns", "st_dev", "st_ino")
        if total != before.st_size or any(getattr(before, key) != getattr(after, key) for key in stable):
            raise RuntimeError("changed file was modified while being collected")
        mode = b"100755\0" if before.st_mode & 0o111 else b"100644\0"
        os.write(1, mode + b"".join(chunks))
    finally:
        os.close(file_fd)
finally:
    os.close(fd)
`;

async function readStableFile(
  root: string,
  path: string,
  remainingBytes: number,
  execute: Execute,
  env: NodeJS.ProcessEnv,
  componentDelayMs: number,
): Promise<{ content: Buffer; mode: "100644" | "100755" }> {
  const result = await execute(
    "python3",
    [
      "-I",
      "-c",
      SECURE_READ_SCRIPT,
      root,
      path,
      String(remainingBytes),
      String(componentDelayMs),
    ],
    {
      cwd: root,
      env,
      captureLimitBytes: remainingBytes + 4096,
    },
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8");
    if (detail.includes("content limit exceeded")) {
      throw new Error("content limit exceeded");
    }
    if (detail.includes("unsupported changed file type")) {
      throw new Error(`unsupported changed file type: ${path}`);
    }
    throw new Error(`could not securely read changed file: ${path}`);
  }
  const separator = result.stdout.indexOf(0);
  const mode = result.stdout.subarray(0, separator).toString("ascii");
  if (
    separator < 0 ||
    (mode !== "100644" && mode !== "100755") ||
    result.stdout.byteLength - separator - 1 > remainingBytes
  ) {
    throw new Error(`invalid secure file reader output: ${path}`);
  }
  return {
    content: result.stdout.subarray(separator + 1),
    mode,
  };
}

export async function collectOperations(
  root: string,
  execute: Execute,
  env: NodeJS.ProcessEnv,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
  componentDelayMs = 0,
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
    safeFile(root, path);
    let file: Awaited<ReturnType<typeof readStableFile>>;
    try {
      file = await readStableFile(
        root,
        path,
        maxBytes - totalBytes,
        execute,
        env,
        componentDelayMs,
      );
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
