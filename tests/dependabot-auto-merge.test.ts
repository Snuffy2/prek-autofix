import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
let authorizeDependabotUpdate: (input: unknown) => string;

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

function pullRequestEvent(action = "synchronize") {
  return {
    action,
    repository: {
      default_branch: "main",
      fork: false,
      full_name: "Snuffy2/prek-autofix",
    },
    pull_request: {
      base: { ref: "main", sha: currentBaseSha },
      head: {
        ref: "dependabot/npm_and_yarn/vitest-4.1.12",
        repo: { full_name: "Snuffy2/prek-autofix" },
        sha: headSha,
      },
      user: { login: "dependabot[bot]" },
    },
  };
}

function dependabotCommit(sha = headSha) {
  return {
    author: { login: "dependabot[bot]" },
    commit: { verification: { verified: true } },
    parents: [],
    sha,
  };
}

function updateCommit(sha: string, previous: string, base: string) {
  return {
    author: { login: "Snuffy2" },
    commit: { verification: { verified: true } },
    committer: { login: "web-flow" },
    parents: [{ sha: previous }, { sha: base }],
    sha,
  };
}

function authorize(changedFiles: string[], event = pullRequestEvent("opened")) {
  return authorizeDependabotUpdate({
    actor: "dependabot[bot]",
    changedFiles,
    commits: [dependabotCommit()],
    event,
    trustedBaseDirectory: root,
  });
}

describe("Dependabot auto-merge authorization", () => {
  it("authorizes a verified npm manifest and lockfile update", () => {
    expect(authorize(["package.json", "package-lock.json"])).toBe("npm");
  });

  it.each([
    ["a missing lockfile", ["package.json"]],
    [
      "a generated bundle",
      ["package.json", "package-lock.json", "dist/apply/index.js"],
    ],
  ])("rejects npm updates with %s", (_caseName, changedFiles) => {
    expect(() => authorize(changedFiles)).toThrow();
  });

  it("authorizes trusted GitHub Actions files from the base", () => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref =
      "dependabot/github_actions/actions/checkout-7";

    expect(
      authorize(
        [
          ".github/workflows/ci.yml",
          "action.yml",
          "review/action.yml",
          "fix/action.yml",
        ],
        event,
      ),
    ).toBe("github-actions");
  });

  it("rejects an action manifest absent from the trusted base", () => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref =
      "dependabot/github_actions/actions/checkout-7";

    expect(() => authorize(["action.yaml"], event)).toThrow();
  });

  it("authorizes a verified GitHub Update branch chain", () => {
    expect(
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          updateCommit(firstUpdateSha, dependabotSha, firstBaseSha),
          updateCommit(headSha, firstUpdateSha, currentBaseSha),
        ],
        event: pullRequestEvent(),
      }),
    ).toBe("npm");
  });

  it("rejects a direct maintainer edit before an Update branch merge", () => {
    const maintainerSha = "6".repeat(40);
    expect(() =>
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          {
            author: { login: "Snuffy2" },
            parents: [{ sha: dependabotSha }],
            sha: maintainerSha,
          },
          updateCommit(headSha, maintainerSha, currentBaseSha),
        ],
        event: pullRequestEvent(),
      }),
    ).toThrow();
  });
});
