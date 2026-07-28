import { describe, expect, it } from "vitest";

import {
  ARTIFACT_SCHEMA_VERSION,
  artifactName,
  isSafeRepositoryPath,
  isWorkflowPath,
  parseChangeArtifact,
} from "../../packages/shared/src/artifact";

const validArtifact = {
  schemaVersion: ARTIFACT_SCHEMA_VERSION,
  source: {
    runId: 42,
    repository: "owner/repository",
    workflow: "prek-autofix",
    event: "pull_request",
    pullRequestNumber: 7,
    headSha: "a".repeat(40),
  },
  operations: [
    {
      path: "src/file.ts",
      operation: "modify",
      mode: "100644",
      content: Buffer.from("fixed\n").toString("base64"),
    },
  ],
};

describe("artifact contract", () => {
  it("parses a valid artifact", () => {
    expect(parseChangeArtifact(validArtifact)).toEqual(validArtifact);
    expect(artifactName(42)).toBe("prek-autofix-42");
  });

  it.each([
    "",
    ".",
    "..",
    "../secret",
    "src/../secret",
    "/absolute",
    "C:/absolute",
    "src\\file",
    "src/\0file",
  ])("rejects unsafe repository path %j", (candidate) => {
    expect(isSafeRepositoryPath(candidate)).toBe(false);
  });

  it("recognizes workflow paths", () => {
    expect(isWorkflowPath(".github/workflows/check.yml")).toBe(true);
    expect(isWorkflowPath(".github/dependabot.yml")).toBe(false);
  });

  it.each([
    ".github/workflows/check.yml",
    ".github/workflows/nested/check.yml",
  ])("rejects workflow operation %j", (path) => {
    expect(() =>
      parseChangeArtifact({
        ...validArtifact,
        operations: [{ ...validArtifact.operations[0], path }],
      }),
    ).toThrow(/workflow files/);
  });

  it("allows workflow-like paths outside the protected directory", () => {
    expect(() =>
      parseChangeArtifact({
        ...validArtifact,
        operations: [
          { ...validArtifact.operations[0], path: ".github/workflow/check.yml" },
        ],
      }),
    ).not.toThrow();
  });

  it.each(["120000", "160000", "040000", "100600"])(
    "rejects unsafe Git mode %s",
    (mode) => {
      expect(() =>
        parseChangeArtifact({
          ...validArtifact,
          operations: [{ ...validArtifact.operations[0], mode }],
        }),
      ).toThrow(/invalid mode/);
    },
  );

  it.each(["100644", "100755"])("accepts regular Git mode %s", (mode) => {
    expect(() =>
      parseChangeArtifact({
        ...validArtifact,
        operations: [{ ...validArtifact.operations[0], mode }],
      }),
    ).not.toThrow();
  });

  it("rejects duplicate paths", () => {
    expect(() =>
      parseChangeArtifact({
        ...validArtifact,
        operations: [
          validArtifact.operations[0],
          validArtifact.operations[0],
        ],
      }),
    ).toThrow(/duplicate path/);
  });

  it("enforces decoded content limits", () => {
    expect(() => parseChangeArtifact(validArtifact, 100, 1)).toThrow(
      /exceeds maximum/,
    );
  });

  it("rejects invalid configured limits", () => {
    expect(() => parseChangeArtifact(validArtifact, -1, 10)).toThrow(
      /file count/,
    );
    expect(() => parseChangeArtifact(validArtifact, 10, Number.NaN)).toThrow(
      /byte count/,
    );
  });

  it("rejects ancestor and descendant path collisions", () => {
    expect(() =>
      parseChangeArtifact({
        ...validArtifact,
        operations: [
          {
            path: "src",
            operation: "delete",
            mode: "100644",
          },
          {
            ...validArtifact.operations[0],
            path: "src/file.ts",
          },
        ],
      }),
    ).toThrow(/conflicting paths/);
  });
});
