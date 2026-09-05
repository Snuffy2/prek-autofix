import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const VALIDATOR = resolve(".github/scripts/validate-release-candidate.mjs");
const RELEASE_TAG = "v1.0.8";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeCandidate(
  directory: string,
  packageContent = JSON.stringify({ version: "1.0.8" }),
): void {
  mkdirSync(join(directory, "dist/apply"), { recursive: true });
  mkdirSync(join(directory, "dist/collect"), { recursive: true });
  writeFileSync(join(directory, "dist/apply/index.js"), "apply bundle");
  writeFileSync(join(directory, "dist/collect/index.js"), "collect bundle");
  writeFileSync(join(directory, "package.json"), packageContent);
  writeJson(join(directory, "package-lock.json"), {
    version: "1.0.8",
    packages: { "": { version: "1.0.8" } },
  });
}

function workspace(): { candidate: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "prek-autofix-candidate-"));
  const candidate = join(root, "candidate");
  mkdirSync(candidate);
  mkdirSync(join(root, "dist/apply"), { recursive: true });
  mkdirSync(join(root, "dist/collect"), { recursive: true });
  writeJson(join(root, "package.json"), { version: "1.0.7" });
  writeJson(join(root, "package-lock.json"), {
    version: "1.0.7",
    packages: { "": { version: "1.0.7" } },
  });
  return { candidate, root };
}

function stageCandidate(candidate: string, root: string): void {
  execFileSync(process.execPath, [VALIDATOR, RELEASE_TAG, candidate, root], {
    stdio: "pipe",
  });
}

function expectOriginalWorkspace(root: string): void {
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
    version: "1.0.7",
  });
  expect(existsSync(join(root, "dist/apply/index.js"))).toBe(false);
}

describe("release candidate validation", () => {
  it("stages only the validated release artifact", () => {
    const { candidate, root } = workspace();
    try {
      writeCandidate(candidate);

      stageCandidate(candidate, root);

      expect(
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
      ).toEqual({
        version: "1.0.8",
      });
      expect(readFileSync(join(root, "dist/apply/index.js"), "utf8")).toBe(
        "apply bundle",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects an oversized candidate before parsing its metadata", () => {
    const { candidate, root } = workspace();
    try {
      writeCandidate(candidate, "x".repeat(10 * 1024 * 1024 + 1));

      expect(() => stageCandidate(candidate, root)).toThrow(
        "Release candidate path is too large: package.json",
      );
      expectOriginalWorkspace(root);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects malformed candidate metadata without changing the workspace", () => {
    const { candidate, root } = workspace();
    try {
      writeCandidate(candidate, "{");

      expect(() => stageCandidate(candidate, root)).toThrow("SyntaxError");
      expectOriginalWorkspace(root);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects candidate metadata beyond the release version without changing the workspace", () => {
    const { candidate, root } = workspace();
    try {
      writeCandidate(
        candidate,
        JSON.stringify({ extra: true, version: "1.0.8" }),
      );

      expect(() => stageCandidate(candidate, root)).toThrow(
        "Release candidate package.json changes metadata beyond its version.",
      );
      expectOriginalWorkspace(root);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects non-regular candidate paths without changing the workspace", () => {
    const { candidate, root } = workspace();
    try {
      writeCandidate(candidate);
      symlinkSync(
        join(candidate, "package.json"),
        join(candidate, "extra-link"),
      );

      expect(() => stageCandidate(candidate, root)).toThrow(
        "Release candidate contains a non-regular path: extra-link",
      );
      expectOriginalWorkspace(root);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
