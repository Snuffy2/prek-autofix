import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ChangeArtifact, FileOperation } from "../../shared/src/artifact";

export interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type Execute = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
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
  const head = await execute("git", ["rev-parse", "HEAD"], { cwd: root, env });
  if (head.exitCode !== 0 || head.stdout.toString("utf8").trim() !== expectedSha) {
    throw new Error("checkout HEAD does not match pull request head SHA");
  }
  const status = await execute("git", ["status", "--porcelain=v1", "-z"], {
    cwd: root,
    env,
  });
  if (status.exitCode !== 0) throw new Error("could not inspect checkout status");
  if (status.stdout.length !== 0) throw new Error("initial checkout is not clean");
}

async function trackedModes(
  root: string,
  execute: Execute,
  env: NodeJS.ProcessEnv,
): Promise<Map<string, string>> {
  const result = await execute("git", ["ls-tree", "-r", "-z", "HEAD"], {
    cwd: root,
    env,
  });
  if (result.exitCode !== 0) throw new Error("could not inspect tracked files");
  const modes = new Map<string, string>();
  for (const record of fields(result.stdout)) {
    const match = /^(\d{6})\s+\w+\s+[0-9a-f]+\t(.+)$/.exec(record);
    if (match?.[1] && match[2]) modes.set(match[2], match[1]);
  }
  return modes;
}

function safeFile(root: string, file: string): string {
  const absolute = resolve(root, file);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`unsafe changed path: ${file}`);
  }
  return absolute;
}

export async function collectOperations(
  root: string,
  execute: Execute,
  env: NodeJS.ProcessEnv,
): Promise<FileOperation[]> {
  const [diff, untracked, originalModes] = await Promise.all([
    execute(
      "git",
      ["diff", "--name-status", "-z", "--no-renames", "HEAD", "--"],
      { cwd: root, env },
    ),
    execute("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      env,
    }),
    trackedModes(root, execute, env),
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

  const operations = await Promise.all(
    entries.map(async ({ operation, path }) => {
      if (operation === "delete") {
        return {
          path,
          operation,
          mode: originalModes.get(path) ?? "100644",
        } satisfies FileOperation;
      }
      const absolute = safeFile(root, path);
      const info = await lstat(absolute);
      if (!info.isFile()) throw new Error(`unsupported changed file type: ${path}`);
      const content = await readFile(absolute);
      return {
        path,
        operation,
        mode: info.mode & 0o111 ? "100755" : "100644",
        content: content.toString("base64"),
      } satisfies FileOperation;
    }),
  );
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
