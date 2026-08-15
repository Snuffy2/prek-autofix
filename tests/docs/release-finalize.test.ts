import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_SHA = "1".repeat(40);
const RELEASE_SHA = "2".repeat(40);
const RELEASE_FILES = [
  "dist/apply/index.js",
  "dist/collect/index.js",
  "package-lock.json",
  "package.json",
];

function writeReleaseFiles(
  root: string,
  version: string,
  marker: string,
): void {
  for (const relativePath of RELEASE_FILES) {
    const path = join(root, relativePath);
    mkdirSync(resolve(path, ".."), { recursive: true });
    if (relativePath === "package.json") {
      writeFileSync(path, `${JSON.stringify({ version })}\n`);
    } else if (relativePath === "package-lock.json") {
      writeFileSync(
        path,
        `${JSON.stringify({ version, packages: { "": { version } } })}\n`,
      );
    } else {
      writeFileSync(path, marker);
    }
  }
}

function runFinalizer(branchSha = SOURCE_SHA): {
  calls: string;
  output: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "prek-autofix-finalize-"));
  const releaseDirectory = join(directory, "release");
  const preparedDirectory = join(directory, "prepared");
  const binDirectory = join(directory, "bin");
  const callsPath = join(directory, "calls");
  const outputPath = join(directory, "output");
  mkdirSync(binDirectory, { recursive: true });
  writeReleaseFiles(releaseDirectory, "1.0.7", "old");
  writeReleaseFiles(preparedDirectory, "1.0.8", "new");
  const gitPath = join(binDirectory, "git");
  writeFileSync(
    gitPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALLS_PATH"
case "$1" in
status)
  exit 0
  ;;
diff)
  if [[ "$2" == "--name-only" ]]; then
    printf '%s\n' ${RELEASE_FILES.map((path) => `'${path}'`).join(" ")}
    exit 0
  fi
  [[ "$2" == "--cached" && "$3" == "--quiet" ]] && exit 1
  ;;
ls-remote)
  printf '%s\trefs/heads/main\n' "$BRANCH_SHA"
  printf '%s\trefs/tags/v1.0.8\n' "$SOURCE_SHA"
  exit 0
  ;;
add|config|commit)
  exit 0
  ;;
rev-parse)
  printf '%s\n' "$RELEASE_SHA"
  exit 0
  ;;
-c)
  [[ "$3" == "push" ]] || exit 2
  exit 0
  ;;
esac
printf 'unexpected git call: %s\n' "$*" >&2
exit 2
`,
  );
  chmodSync(gitPath, 0o755);
  try {
    execFileSync(
      process.execPath,
      [resolve(".github/scripts/finalize-release.mjs")],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          BRANCH_SHA: branchSha,
          CALLS_PATH: callsPath,
          DEFAULT_BRANCH: "main",
          GH_TOKEN: "token-sentinel",
          GITHUB_OUTPUT: outputPath,
          PATH: `${binDirectory}:${process.env.PATH}`,
          PREPARED_DIRECTORY: preparedDirectory,
          RELEASE_DIRECTORY: releaseDirectory,
          RELEASE_SHA,
          RELEASE_TAG: "v1.0.8",
          SOURCE_SHA,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return {
      calls: readFileSync(callsPath, "utf8"),
      output: readFileSync(outputPath, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("release finalization", () => {
  it("atomically rewrites the default branch and published release tag", () => {
    const result = runFinalizer();

    expect(result.output).toBe(`sha=${RELEASE_SHA}\n`);
    expect(result.calls).toContain(
      "commit -m Updating to version v1.0.8 [skip ci]",
    );
    expect(result.calls).toContain("push --atomic");
    expect(result.calls).toContain(
      `--force-with-lease=refs/heads/main:${SOURCE_SHA}`,
    );
    expect(result.calls).toContain(
      `--force-with-lease=refs/tags/v1.0.8:${SOURCE_SHA}`,
    );
    expect(result.calls).toContain("HEAD:refs/heads/main");
    expect(result.calls).toContain("+HEAD:refs/tags/v1.0.8");
    expect(result.calls).not.toContain("token-sentinel");
  });

  it("fails if the default branch advances during preparation", () => {
    expect(() => runFinalizer("3".repeat(40))).toThrow();
  });
});
