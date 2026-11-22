import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const action = vi.hoisted(() => ({
  outputs: new Map<string, string>(),
  setFailed: vi.fn<(message: string) => void>(),
  head: { sha: "" },
}));

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  setOutput: (name: string, value: string) => action.outputs.set(name, value),
  setFailed: action.setFailed,
}));

vi.mock("@actions/github", () => ({
  context: {
    eventName: "pull_request",
    runId: 42,
    runAttempt: 3,
    repo: { owner: "owner", repo: "repo" },
    workflow: "prek-autofix",
    payload: {
      pull_request: {
        number: 7,
        user: { login: "contributor" },
        head: action.head,
      },
    },
  },
}));

let directory: string | undefined;

afterEach(async () => {
  action.outputs.clear();
  action.setFailed.mockClear();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function review(hook: string): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "review-action-"));
  const checkout = join(directory, "checkout");
  const workingDirectory = join(checkout, "docs");
  const artifactDirectory = join(directory, "artifacts");
  const bin = join(directory, "bin");
  for (const path of [workingDirectory, artifactDirectory, bin]) {
    await mkdir(path, { recursive: true });
  }
  vi.stubEnv("HOME", directory);
  vi.stubEnv("XDG_CONFIG_HOME", join(directory, "xdg-config"));
  function git(...args: string[]): string {
    return execFileSync("/usr/bin/git", args, {
      cwd: checkout,
      encoding: "utf8",
    }).trim();
  }
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  await writeFile(join(workingDirectory, "note.txt"), "original\n");
  git("add", "docs/note.txt");
  git("commit", "-qm", "Source commit");
  action.head.sha = git("rev-parse", "HEAD");
  await writeFile(join(bin, "prek"), `#!/bin/sh\nset -eu\n${hook}\n`, {
    mode: 0o755,
  });

  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("GITHUB_WORKSPACE", checkout);
  vi.stubEnv("RUNNER_TEMP", artifactDirectory);
  vi.stubEnv("PREK_AUTOFIX_EXTRA_ARGS", "--all-files");
  vi.stubEnv("PREK_AUTOFIX_WORKING_DIRECTORY", "docs");
  vi.stubEnv("PREK_AUTOFIX_IGNORE_AUTHORS", "");
  vi.stubEnv("PREK_AUTOFIX_MAX_PASSES", "2");
  vi.stubEnv("PREK_AUTOFIX_MAX_LOG_BYTES", "1024");
  vi.stubEnv("PREK_AUTOFIX_MAX_FILES", "1");
  vi.stubEnv("PREK_AUTOFIX_MAX_BYTES", "32");
  vi.stubEnv("PREK_AUTOFIX_PASS_TIMEOUT_SECONDS", "5");
  vi.resetModules();
  const { completion } = await import("../../packages/collect/src/index.js");
  await completion;
  return artifactDirectory;
}

describe.skipIf(process.platform !== "linux")("review Action checkout", () => {
  it("succeeds on a clean pass without an artifact", async () => {
    const artifacts = await review("exit 0");

    expect(action.setFailed).not.toHaveBeenCalled();
    expect(action.outputs.get("changed")).toBe("false");
    expect(action.outputs.get("artifact-name")).toBe("");
    expect(action.outputs.get("artifact-path")).toBe("");
    expect(await readdir(artifacts)).toEqual([]);
  });

  it("publishes stable fixes alongside remaining hook findings", async () => {
    await review("printf 'tidy\\n' > note.txt\nexit 1");

    expect(action.setFailed).not.toHaveBeenCalled();
    expect(action.outputs.get("changed")).toBe("true");
    expect(action.outputs.get("artifact-name")).toBe("prek-autofix-42-3");
    const path = action.outputs.get("artifact-path");
    expect(path).toBeTruthy();
    const contents = JSON.parse(await readFile(path!, "utf8")) as unknown;
    expect(contents).toMatchObject({
      source: { headSha: action.head.sha, runAttempt: 3 },
      operations: [
        {
          path: "docs/note.txt",
          operation: "modify",
          mode: "100644",
          content: Buffer.from("tidy\n").toString("base64"),
        },
      ],
    });
  });

  it("fails without publishing continually changing fixes", async () => {
    const artifacts = await review("printf 'a\\n' >> note.txt");

    expect(action.setFailed).toHaveBeenCalledWith(
      "prek did not converge after 2 passes",
    );
    expect(action.outputs.get("changed")).toBe("true");
    expect(action.outputs.get("artifact-name")).toBe("");
    expect(action.outputs.get("artifact-path")).toBe("");
    expect(await readdir(artifacts)).toEqual([]);
  });

  it("fails before publishing when HEAD changes during the pass", async () => {
    const artifacts = await review("git commit --allow-empty -qm 'New head'");

    expect(action.setFailed).toHaveBeenCalledWith(
      "checkout HEAD does not match pull request head SHA",
    );
    expect(action.outputs.has("artifact-name")).toBe(false);
    expect(action.outputs.has("artifact-path")).toBe(false);
    expect(await readdir(artifacts)).toEqual([]);
  });

  it("fails before persisting when the artifact destination is replaced", async () => {
    const artifacts = await review(`
      printf 'tidy\\n' > note.txt
      if [ ! -d "$RUNNER_TEMP-previous" ]; then
        mv "$RUNNER_TEMP" "$RUNNER_TEMP-previous"
        mkdir "$RUNNER_TEMP"
      fi
    `);

    expect(action.setFailed).toHaveBeenCalledWith(
      "workspace identity changed while hooks were running",
    );
    expect(action.outputs.get("artifact-name")).toBe("");
    expect(action.outputs.get("artifact-path")).toBe("");
    expect(await readdir(artifacts)).toEqual([]);
    expect(await readdir(`${artifacts}-previous`)).toEqual([]);
  });
});
