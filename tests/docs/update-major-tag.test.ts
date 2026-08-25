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

const RELEASE_TAG = "v2.0.3";
const TARGET_SHA = "1".repeat(40);
const RELEASE_TAG_OBJECT_SHA = "2".repeat(40);
const CURRENT_MAJOR_SHA = "3".repeat(40);

type MajorTagAction = "create" | "update";
type ReleaseRefType = "commit" | "tag";

interface GraphQLCall {
  readonly bindings: Readonly<Record<string, string>>;
  readonly query: string;
}

interface Tag {
  readonly commit: { readonly sha: string };
  readonly name: string;
}

function runMajorTagUpdate(
  action: MajorTagAction,
  releaseRefType: ReleaseRefType,
): GraphQLCall {
  const directory = mkdtempSync(join(tmpdir(), "prek-autofix-major-tag-"));
  const binDirectory = join(directory, "bin");
  const bindingsPath = join(directory, "bindings");
  const queryPath = join(directory, "query");
  const ghPath = join(binDirectory, "gh");
  mkdirSync(binDirectory);
  const releaseTag: Tag = {
    commit: { sha: TARGET_SHA },
    name: RELEASE_TAG,
  };
  const tags =
    action === "create"
      ? [releaseTag]
      : [
          releaseTag,
          { commit: { sha: CURRENT_MAJOR_SHA }, name: "v2.0.2" },
          { commit: { sha: CURRENT_MAJOR_SHA }, name: "v2" },
        ];
  const releases = tags.map((tag) => ({
    draft: false,
    prerelease: false,
    published_at: "2026-01-01T00:00:00Z",
    tag_name: tag.name,
  }));
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "api" ]]; then
  exit 2
fi
shift
if [[ "$1" == "graphql" ]]; then
  query=""
  for argument in "$@"; do
    if [[ "$argument" == query=* ]]; then
      query="\${argument#query=}"
    elif [[ "$argument" == *=* ]]; then
      printf '%s\\n' "$argument" >> "$BINDINGS_PATH"
    fi
  done
  printf '%s' "$query" > "$QUERY_PATH"
  if [[ "$RELEASE_REF_TYPE" == "tag" && "$query" == *'$pointName'* ]]; then
    printf '%s\\n' 'gh: Invalid object type tag, expected commit' >&2
    exit 1
  fi
  printf '%s\\n' '{"data":{"updateRefs":{"clientMutationId":null}}}'
  exit 0
fi
request="$*"
if [[ "$request" == *"git/ref/tags/$RELEASE_TAG"* ]]; then
  printf '%s\\t%s\\n' "$RELEASE_REF_OID" "$RELEASE_REF_TYPE"
elif [[ "$request" == *"git/tags/$RELEASE_TAG_OBJECT_SHA"* ]]; then
  printf '%s\\t%s\\n' "$TARGET_SHA" commit
elif [[ "$request" == *"git/ref/tags/v2"* ]]; then
  printf '%s\\t%s\\n' "$CURRENT_MAJOR_SHA" commit
elif [[ "$request" == *"tags?per_page=100"* ]]; then
  printf '%s' "$TAGS_JSON"
elif [[ "$request" == *"releases?per_page=100"* ]]; then
  printf '%s' "$RELEASES_JSON"
elif [[ "$request" == *"repos/owner/repository"* ]]; then
  printf '%s\\n' repo-node-id
else
  exit 2
fi
`,
  );
  chmodSync(ghPath, 0o755);

  try {
    execFileSync("bash", [resolve(".github/scripts/update-major-tag.sh")], {
      cwd: resolve("."),
      env: {
        ...process.env,
        BINDINGS_PATH: bindingsPath,
        GH_TOKEN: "token-sentinel",
        GITHUB_REPOSITORY: "owner/repository",
        PATH: `${binDirectory}:${process.env.PATH}`,
        QUERY_PATH: queryPath,
        RELEASES_JSON: JSON.stringify([releases]),
        RELEASE_TAG,
        RELEASE_TAG_OBJECT_SHA,
        RELEASE_REF_OID:
          releaseRefType === "tag" ? RELEASE_TAG_OBJECT_SHA : TARGET_SHA,
        RELEASE_REF_TYPE: releaseRefType,
        TAGS_JSON: JSON.stringify([tags]),
        TARGET_SHA,
        CURRENT_MAJOR_SHA,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const bindings = Object.fromEntries(
      readFileSync(bindingsPath, "utf8")
        .trim()
        .split("\n")
        .map((binding) => {
          const separator = binding.indexOf("=");
          return [binding.slice(0, separator), binding.slice(separator + 1)];
        }),
    );
    return { bindings, query: readFileSync(queryPath, "utf8") };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    throw new Error(stderr?.toString().trim() || "major tag update failed", {
      cause: error,
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("major tag updates", () => {
  it.each([{ action: "update" as const }, { action: "create" as const }])(
    "atomically guards a lightweight release tag during $action",
    ({ action }) => {
      const { bindings, query } = runMajorTagUpdate(action, "commit");
      const normalizedQuery = query.replace(/\s+/gu, " ");

      expect(normalizedQuery).toContain(
        "name: $pointName beforeOid: $pointOid afterOid: $pointOid force: false",
      );
      expect(bindings.pointName).toBe(`refs/tags/${RELEASE_TAG}`);
      expect(bindings.pointOid).toBe(TARGET_SHA);
    },
  );

  it.each([{ action: "update" as const }, { action: "create" as const }])(
    "updates the major tag for an annotated release tag during $action",
    ({ action }) => {
      const { bindings, query } = runMajorTagUpdate(action, "tag");

      expect(query).not.toContain("$pointName");
      expect(bindings).not.toHaveProperty("pointName");
      expect(bindings).not.toHaveProperty("pointOid");
      expect(bindings.majorName).toBe("refs/tags/v2");
      expect(bindings.majorAfterOid).toBe(TARGET_SHA);
    },
  );
});
