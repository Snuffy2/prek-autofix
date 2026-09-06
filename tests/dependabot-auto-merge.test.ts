import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

interface Commit {
  readonly author: { readonly login: string };
  readonly commit: { readonly verification: { readonly verified: boolean } };
  readonly committer?: { readonly login: string };
  readonly parents: { readonly sha: string }[];
  readonly sha: string;
}

interface AuthorizationInput {
  readonly actor: string;
  readonly changedFiles: string[];
  readonly commits: Commit[];
  readonly event: ReturnType<typeof pullRequestEvent>;
  readonly trustedBaseDirectory: string;
}

const root = resolve(__dirname, "..");
let authorizeDependabotUpdate: (input: AuthorizationInput) => string;

beforeAll(async () => {
  ({ authorizeDependabotUpdate } = await import(
    pathToFileURL(resolve(root, ".github/scripts/dependabot-auto-merge.mjs"))
      .href
  ));
});

const dependabotSha = "1".repeat(40);
const firstBaseSha = "2".repeat(40);
const firstUpdateSha = "3".repeat(40);
const currentBaseSha = "4".repeat(40);
const headSha = "5".repeat(40);
const temporaryDirectories: string[] = [];

function pullRequestEvent(headRef: string, action = "synchronize") {
  return {
    action,
    repository: {
      default_branch: "main",
      fork: false,
      full_name: "example/repository",
    },
    pull_request: {
      base: { ref: "main", sha: currentBaseSha },
      head: {
        ref: headRef,
        repo: { full_name: "example/repository" },
        sha: headSha,
      },
      user: { login: "dependabot[bot]" },
    },
  };
}

function dependabotCommit(sha = headSha): Commit {
  return {
    author: { login: "dependabot[bot]" },
    commit: { verification: { verified: true } },
    parents: [],
    sha,
  };
}

function updateCommit(sha: string, previous: string, base: string): Commit {
  return {
    author: { login: "maintainer" },
    commit: { verification: { verified: true } },
    committer: { login: "web-flow" },
    parents: [{ sha: previous }, { sha: base }],
    sha,
  };
}

function trustedBaseWith(...paths: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "dependabot-authorizer-"));
  temporaryDirectories.push(directory);
  for (const path of paths) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture\n");
  }
  return directory;
}

function authorize({
  actor = "dependabot[bot]",
  changedFiles,
  commits = [dependabotCommit()],
  headRef,
  trustedBaseDirectory,
}: {
  readonly actor?: string;
  readonly changedFiles: string[];
  readonly commits?: Commit[];
  readonly headRef: string;
  readonly trustedBaseDirectory: string;
}): string {
  return authorizeDependabotUpdate({
    actor,
    changedFiles,
    commits,
    event: pullRequestEvent(
      headRef,
      actor === "dependabot[bot]" ? "opened" : "synchronize",
    ),
    trustedBaseDirectory,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("Dependabot auto-merge authorization", () => {
  it("authorizes an existing trusted uv lockfile", () => {
    expect(
      authorize({
        changedFiles: ["uv.lock"],
        headRef: "dependabot/uv/pytest-9.0.0",
        trustedBaseDirectory: trustedBaseWith("uv.lock"),
      }),
    ).toBe("uv");
  });

  it("rejects uv updates when the trusted base uses npm", () => {
    expect(() =>
      authorize({
        changedFiles: ["uv.lock"],
        headRef: "dependabot/uv/pytest-9.0.0",
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toThrow();
  });

  it("authorizes npm lock-only updates from an npm base", () => {
    expect(
      authorize({
        changedFiles: ["package-lock.json"],
        headRef: "dependabot/npm_and_yarn/vitest-4.1.11",
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toBe("npm");
  });

  it("authorizes npm manifest and lockfile updates together", () => {
    expect(
      authorize({
        changedFiles: ["package.json", "package-lock.json"],
        headRef: "dependabot/npm_and_yarn/vitest-4.1.11",
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toBe("npm");
  });

  it("rejects npm updates without a lockfile or with generated bundles", () => {
    const trustedBaseDirectory = trustedBaseWith(
      "package.json",
      "package-lock.json",
    );
    for (const changedFiles of [
      ["package.json"],
      ["package-lock.json", "dist/apply/index.js"],
      ["package-lock.json", "package-lock.json"],
    ])
      expect(() =>
        authorize({
          changedFiles,
          headRef: "dependabot/npm_and_yarn/vitest-4.1.11",
          trustedBaseDirectory,
        }),
      ).toThrow();
  });

  it("rejects npm updates when the trusted base uses uv", () => {
    expect(() =>
      authorize({
        changedFiles: ["package-lock.json"],
        headRef: "dependabot/npm_and_yarn/vitest-4.1.11",
        trustedBaseDirectory: trustedBaseWith("uv.lock"),
      }),
    ).toThrow();
  });

  it("authorizes existing trusted workflow and nested action manifests", () => {
    const trustedBaseDirectory = trustedBaseWith(
      ".github/workflows/ci.yml",
      "action.yml",
      "review/action.yaml",
      "fix/action.yml",
      "actions/release/action.yaml",
    );
    for (const changedFiles of [
      [".github/workflows/ci.yml"],
      ["action.yml"],
      ["review/action.yaml"],
      ["fix/action.yml"],
      ["actions/release/action.yaml"],
    ])
      expect(
        authorize({
          changedFiles,
          headRef: "dependabot/github_actions/actions/checkout-7",
          trustedBaseDirectory,
        }),
      ).toBe("github-actions");
  });

  it("rejects untrusted GitHub Actions paths", () => {
    const trustedBaseDirectory = trustedBaseWith(
      ".github/workflows/nested/ci.yml",
      "action.yml",
    );
    for (const changedFiles of [
      [".github/workflows/nested/ci.yml"],
      ["../action.yml"],
    ])
      expect(() =>
        authorize({
          changedFiles,
          headRef: "dependabot/github_actions/actions/checkout-7",
          trustedBaseDirectory,
        }),
      ).toThrow();
  });

  it("authorizes a verified GitHub Update branch chain", () => {
    const event = pullRequestEvent("dependabot/npm_and_yarn/vitest-4.1.11");
    expect(
      authorizeDependabotUpdate({
        actor: "maintainer",
        changedFiles: ["package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          updateCommit(firstUpdateSha, dependabotSha, firstBaseSha),
          updateCommit(headSha, firstUpdateSha, currentBaseSha),
        ],
        event,
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toBe("npm");
  });

  it("rejects an invalid GitHub Update branch chain", () => {
    const event = pullRequestEvent("dependabot/npm_and_yarn/vitest-4.1.11");
    expect(() =>
      authorizeDependabotUpdate({
        actor: "maintainer",
        changedFiles: ["package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          {
            author: { login: "maintainer" },
            commit: { verification: { verified: true } },
            committer: { login: "maintainer" },
            parents: [{ sha: dependabotSha }, { sha: currentBaseSha }],
            sha: headSha,
          },
        ],
        event,
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toThrow();
  });
});
