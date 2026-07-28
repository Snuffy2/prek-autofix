import { chmod, constants, mkdtemp, open, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  isSafeRepositoryPath,
  validatePathComponentBudget,
  type ChangeArtifact,
  type FileOperation,
} from "../../shared/src/artifact";

export const GIT_CAPTURE_LIMIT_BYTES = DEFAULT_MAX_BYTES;

export interface RootIdentity {
  canonicalPath: string;
  device: string;
  inode: string;
}

export interface TrustedExecutableIdentity extends RootIdentity {
  mode: string;
  uid: string;
}

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
    superviseProcessTree?: boolean;
    trustedPythonPath?: string;
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

export async function captureRootIdentity(root: string): Promise<RootIdentity> {
  const canonicalPath = await realpath(root);
  const identity = await stat(canonicalPath, { bigint: true });
  if (!identity.isDirectory()) {
    throw new Error("workspace root is not a directory");
  }
  return {
    canonicalPath,
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
  };
}

export async function assertRootIdentity(
  root: string,
  expected: RootIdentity,
): Promise<void> {
  let actual: RootIdentity;
  try {
    actual = await captureRootIdentity(root);
  } catch {
    throw new Error("workspace identity changed while hooks were running");
  }
  if (
    actual.canonicalPath !== expected.canonicalPath ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode
  ) {
    throw new Error("workspace identity changed while hooks were running");
  }
}

export async function captureTrustedPython(
  pathname = "/usr/bin/python3",
): Promise<TrustedExecutableIdentity> {
  const canonicalPath = await realpath(pathname);
  const identity = await stat(canonicalPath, { bigint: true });
  if (
    !identity.isFile() ||
    identity.uid !== 0n ||
    (identity.mode & 0o22n) !== 0n ||
    (identity.mode & 0o111n) === 0n
  ) {
    throw new Error(
      "trusted Python interpreter must be a root-owned, non-writable executable",
    );
  }
  return {
    canonicalPath,
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    mode: identity.mode.toString(),
    uid: identity.uid.toString(),
  };
}

export async function assertTrustedPython(
  expected: TrustedExecutableIdentity,
): Promise<void> {
  let actual: TrustedExecutableIdentity;
  try {
    actual = await captureTrustedPython(expected.canonicalPath);
  } catch {
    throw new Error("trusted Python interpreter identity changed");
  }
  if (
    actual.canonicalPath !== expected.canonicalPath ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.mode !== expected.mode ||
    actual.uid !== expected.uid
  ) {
    throw new Error("trusted Python interpreter identity changed");
  }
}

export async function assertExactHead(
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
}

export async function assertExactCleanCheckout(
  root: string,
  expectedSha: string,
  execute: Execute,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await assertExactHead(root, expectedSha, execute, env);
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
root, path, maximum, delay_ms, expected_dev, expected_ino = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
flags = os.O_RDONLY | os.O_NOFOLLOW
directory_flags = flags | os.O_DIRECTORY
fd = os.open(root, directory_flags)
try:
    root_stat = os.fstat(fd)
    if root_stat.st_dev != expected_dev or root_stat.st_ino != expected_ino:
        raise RuntimeError("workspace identity changed")
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
  expectedRoot: RootIdentity,
  trustedPython: TrustedExecutableIdentity,
): Promise<{ content: Buffer; mode: "100644" | "100755" }> {
  await assertTrustedPython(trustedPython);
  const result = await execute(
    trustedPython.canonicalPath,
    [
      "-I",
      "-c",
      SECURE_READ_SCRIPT,
      root,
      path,
      String(remainingBytes),
      String(componentDelayMs),
      expectedRoot.device,
      expectedRoot.inode,
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
    if (detail.includes("workspace identity changed")) {
      throw new Error("workspace identity changed while collecting changes");
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
  expectedRoot?: RootIdentity,
  trustedPython?: TrustedExecutableIdentity,
): Promise<FileOperation[]> {
  const rootIdentity = expectedRoot ?? (await captureRootIdentity(root));
  const pythonIdentity = trustedPython ?? (await captureTrustedPython());
  await assertRootIdentity(root, rootIdentity);
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
  validatePathComponentBudget(entries.map(({ path }) => path));

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
        rootIdentity,
        pythonIdentity,
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
  expectedRoot?: RootIdentity,
): Promise<string> {
  const rootIdentity = expectedRoot ?? (await captureRootIdentity(root));
  await assertRootIdentity(root, rootIdentity);
  const privateDirectory = await mkdtemp(
    join(rootIdentity.canonicalPath, "prek-autofix-"),
  );
  await chmod(privateDirectory, 0o700);
  const directoryIdentity = await captureRootIdentity(privateDirectory);
  const output = join(directoryIdentity.canonicalPath, "prek-autofix.json");
  const handle = await open(
    output,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(artifact, undefined, 2)}\n`);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || (written.mode & 0o777) !== 0o600) {
      throw new Error("artifact file has unsafe type or permissions");
    }
  } finally {
    await handle.close();
  }
  await assertRootIdentity(root, rootIdentity);
  await assertRootIdentity(privateDirectory, directoryIdentity);
  return output;
}
