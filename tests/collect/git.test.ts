import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectOperations,
  type Execute,
} from "../../packages/collect/src/git";
import { executeCommand } from "../../packages/collect/src/runner";

const directories: string[] = [];
const env = { PATH: process.env.PATH };

async function git(root: string, ...args: string[]): Promise<void> {
  const response = await executeCommand("git", args, { cwd: root, env });
  if (response.exitCode !== 0) throw new Error(response.stderr.toString());
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "collect-git-"));
  directories.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "text.txt"), "old\n");
  await writeFile(join(root, "delete.txt"), "delete\n");
  await writeFile(join(root, "rename.txt"), "rename\n");
  await writeFile(join(root, "script.sh"), "#!/bin/sh\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("collectOperations", () => {
  it("encodes text, binary, executable, add, delete, and rename as delete/add", async () => {
    const root = await repository();
    await writeFile(join(root, "text.txt"), "new\n");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 1]));
    await chmod(join(root, "script.sh"), 0o755);
    await import("node:fs/promises").then(({ unlink, rename }) =>
      Promise.all([
        unlink(join(root, "delete.txt")),
        rename(join(root, "rename.txt"), join(root, "renamed.txt")),
      ]),
    );

    const operations = await collectOperations(root, executeCommand, env);
    expect(operations.map(({ path, operation, mode }) => ({ path, operation, mode })))
      .toEqual([
        { path: "binary.bin", operation: "add", mode: "100644" },
        { path: "delete.txt", operation: "delete", mode: "100644" },
        { path: "rename.txt", operation: "delete", mode: "100644" },
        { path: "renamed.txt", operation: "add", mode: "100644" },
        { path: "script.sh", operation: "modify", mode: "100755" },
        { path: "text.txt", operation: "modify", mode: "100644" },
      ]);
    expect(
      Buffer.from(
        operations.find((item) => item.path === "binary.bin")?.content ?? "",
        "base64",
      ),
    ).toEqual(Buffer.from([0, 255, 1]));
  });
});
