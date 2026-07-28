import {
  chmod,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectOperations,
  GIT_CAPTURE_LIMIT_BYTES,
  operationForGitStatus,
  type Execute,
} from "../../packages/collect/src/git";
import { executeCommand } from "../../packages/collect/src/runner";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
} from "../../packages/shared/src/artifact";

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

  it("encodes a staged addition as add", async () => {
    const root = await repository();
    await writeFile(join(root, "added.txt"), "added\n");
    await git(root, "add", "added.txt");

    const operations = await collectOperations(root, executeCommand, env);

    expect(operations).toEqual([
      {
        path: "added.txt",
        operation: "add",
        mode: "100644",
        content: Buffer.from("added\n").toString("base64"),
      },
    ]);
  });

  it("encodes a staged rename as delete and add", async () => {
    const root = await repository();
    await git(root, "mv", "rename.txt", "renamed.txt");

    const operations = await collectOperations(root, executeCommand, env);

    expect(operations.map(({ path, operation, mode }) => ({ path, operation, mode })))
      .toEqual([
        { path: "rename.txt", operation: "delete", mode: "100644" },
        { path: "renamed.txt", operation: "add", mode: "100644" },
      ]);
  });

  it("rejects 101 changed files before inspecting tracked modes or files", async () => {
    const root = await repository();
    await Promise.all(
      Array.from({ length: DEFAULT_MAX_FILES + 1 }, (_, index) =>
        writeFile(join(root, `file-${index}.txt`), "changed\n"),
      ),
    );
    const execute: Execute = vi.fn(async (command, args, options) =>
      executeCommand(command, args, options),
    );

    await expect(collectOperations(root, execute, env)).rejects.toThrow(
      `collected ${DEFAULT_MAX_FILES + 1} files; maximum is ${DEFAULT_MAX_FILES}`,
    );
    expect(execute).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["ls-tree"]),
      expect.anything(),
    );
  });

  it("rejects a file larger than the content ceiling", async () => {
    const root = await repository();
    await writeFile(join(root, "large.bin"), Buffer.alloc(DEFAULT_MAX_BYTES + 1));

    await expect(collectOperations(root, executeCommand, env)).rejects.toThrow(
      `collected content exceeds maximum of ${DEFAULT_MAX_BYTES} bytes`,
    );
  });

  it("rejects symlinks without following them outside the checkout", async () => {
    if (process.platform === "win32") return;
    const root = await repository();
    const outside = join(root, "..", `${root.split("/").at(-1)}-outside.txt`);
    directories.push(outside);
    await writeFile(outside, "outside\n");
    await symlink(outside, join(root, "linked.txt"));

    await expect(collectOperations(root, executeCommand, env)).rejects.toThrow();
  });

  it("accepts content exactly at the byte ceiling", async () => {
    const root = await repository();
    const content = Buffer.alloc(DEFAULT_MAX_BYTES, 0x5a);
    await writeFile(join(root, "exact.bin"), content);

    const operations = await collectOperations(root, executeCommand, env);

    expect(operations).toHaveLength(1);
    const decoded = Buffer.from(operations[0]?.content ?? "", "base64");
    expect(decoded).toHaveLength(DEFAULT_MAX_BYTES);
    expect(decoded[0]).toBe(0x5a);
    expect(decoded.at(-1)).toBe(0x5a);
  });

  it("accepts exactly the maximum file count", async () => {
    const execute: Execute = vi.fn(async (_command, args) => {
      if (args[0] === "diff") {
        const records = Array.from(
          { length: DEFAULT_MAX_FILES },
          (_, index) => `D\0file-${index}.txt\0`,
        ).join("");
        return {
          exitCode: 0,
          stdout: Buffer.from(records),
          stderr: Buffer.alloc(0),
        };
      }
      if (args[0] === "ls-files") {
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (args[0] === "ls-tree") {
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    const operations = await collectOperations("/unused", execute, env);

    expect(operations).toHaveLength(DEFAULT_MAX_FILES);
  });

  it("looks up modes only for the bounded deleted paths", async () => {
    const root = await repository();
    const execute: Execute = vi.fn(async (command, args, options) => {
      return executeCommand(command, args, options);
    });
    await import("node:fs/promises").then(({ unlink }) =>
      unlink(join(root, "delete.txt")),
    );

    await collectOperations(root, execute, env);

    const modeCall = vi
      .mocked(execute)
      .mock.calls.find(([, args]) => args[0] === "ls-tree");
    expect(modeCall?.[1]).toEqual([
      "ls-tree",
      "-z",
      "HEAD",
      "--",
      "delete.txt",
    ]);
    expect(modeCall?.[1]).not.toContain("-r");
    expect(modeCall?.[2].captureLimitBytes).toBe(GIT_CAPTURE_LIMIT_BYTES);
  });
});

describe("operationForGitStatus", () => {
  it("maps supported statuses and rejects unsupported statuses", () => {
    expect(operationForGitStatus("A")).toBe("add");
    expect(operationForGitStatus("M")).toBe("modify");
    expect(operationForGitStatus("D")).toBe("delete");
    expect(() => operationForGitStatus("T")).toThrow(
      "unsupported git diff status: T",
    );
  });
});
