import { describe, expect, it } from "vitest";

import {
  ARTIFACT_SCHEMA_VERSION,
  DEFAULT_MAX_FILES,
  MAX_PATH_COMPONENTS,
  MAX_TOTAL_PATH_COMPONENTS,
  isSafeRepositoryPath,
  parseChangeArtifact,
} from "../../packages/shared/src/artifact";

const validArtifact = {
  schemaVersion: ARTIFACT_SCHEMA_VERSION,
  source: {
    runId: 42,
    runAttempt: 3,
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
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["fractional", 1.5],
  ])("rejects a %s source run attempt", (_name, runAttempt) => {
    expect(() =>
      parseChangeArtifact({
        ...validArtifact,
        source: { ...validArtifact.source, runAttempt },
      }),
    ).toThrow("source runAttempt must be a positive integer");
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
          {
            ...validArtifact.operations[0],
            path: ".github/workflow/check.yml",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts a path at the component-depth limit", () => {
    const path = Array.from(
      { length: MAX_PATH_COMPONENTS },
      (_, index) => `part-${index}`,
    ).join("/");
    expect(() =>
      parseChangeArtifact({
        ...validArtifact,
        operations: [{ ...validArtifact.operations[0], path }],
      }),
    ).not.toThrow();
  });

  it("rejects a path one component beyond the depth limit", () => {
    const path = Array.from(
      { length: MAX_PATH_COMPONENTS + 1 },
      (_, index) => `part-${index}`,
    ).join("/");
    expect(() =>
      parseChangeArtifact({
        ...validArtifact,
        operations: [{ ...validArtifact.operations[0], path }],
      }),
    ).toThrow(`maximum is ${MAX_PATH_COMPONENTS}`);
  });

  it("accepts paths at the aggregate component limit", () => {
    const componentsPerPath = MAX_TOTAL_PATH_COMPONENTS / 100;
    const operations = Array.from({ length: 100 }, (_, pathIndex) => ({
      ...validArtifact.operations[0],
      path: Array.from(
        { length: componentsPerPath },
        (_, componentIndex) => `p${pathIndex}-${componentIndex}`,
      ).join("/"),
    }));
    expect(() =>
      parseChangeArtifact({ ...validArtifact, operations }),
    ).not.toThrow();
  });

  it("rejects paths one component beyond the aggregate limit", () => {
    const componentsPerPath = MAX_TOTAL_PATH_COMPONENTS / 100;
    const operations = Array.from({ length: 100 }, (_, pathIndex) => ({
      ...validArtifact.operations[0],
      path: Array.from(
        {
          length: componentsPerPath + (pathIndex === 99 ? 1 : 0),
        },
        (_, componentIndex) => `p${pathIndex}-${componentIndex}`,
      ).join("/"),
    }));
    expect(() => parseChangeArtifact({ ...validArtifact, operations })).toThrow(
      `more than ${MAX_TOTAL_PATH_COMPONENTS} total components`,
    );
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
        operations: [validArtifact.operations[0], validArtifact.operations[0]],
      }),
    ).toThrow(/duplicate path/);
  });

  it("enforces the default maximum file count", () => {
    const operations = Array.from(
      { length: DEFAULT_MAX_FILES + 1 },
      (_, index) => ({
        ...validArtifact.operations[0],
        path: `file-${index}.ts`,
      }),
    );

    expect(() => parseChangeArtifact({ ...validArtifact, operations })).toThrow(
      `artifact has ${DEFAULT_MAX_FILES + 1} files; maximum is ${DEFAULT_MAX_FILES}`,
    );
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
            path: "src-old.txt",
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
