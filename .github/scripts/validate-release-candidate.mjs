import { deepStrictEqual } from "node:assert";
import { copyFileSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const RELEASE_FILES = Object.freeze([
  "dist/apply/index.js",
  "dist/collect/index.js",
  "package-lock.json",
  "package.json",
]);
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function artifactFiles(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...artifactFiles(entryPath, root));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Release candidate contains a non-regular path: ${relative(root, entryPath)}`,
      );
    }
    files.push(entryPath);
  }
  return files;
}

export function validateAndStageCandidate({
  releaseTag,
  artifactDirectory,
  workspaceDirectory,
}) {
  const candidateDirectory = resolve(artifactDirectory);
  const workspace = resolve(workspaceDirectory);
  const actualPaths = artifactFiles(candidateDirectory)
    .map((filePath) => relative(candidateDirectory, filePath))
    .sort();
  const expectedPaths = [...RELEASE_FILES].sort();
  deepStrictEqual(actualPaths, expectedPaths);

  let totalBytes = 0;
  for (const relativePath of expectedPaths) {
    const candidatePath = join(candidateDirectory, relativePath);
    const stat = lstatSync(candidatePath);
    if (!stat.isFile()) {
      throw new Error(
        `Release candidate path is not a regular file: ${relativePath}`,
      );
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`Release candidate path is too large: ${relativePath}`);
    }
    totalBytes += stat.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error("Release candidate artifact is too large.");
  }

  const version = releaseTag.slice(1);
  const expectedPackage = readJson(join(workspace, "package.json"));
  const expectedLock = readJson(join(workspace, "package-lock.json"));
  if (
    typeof expectedPackage.version !== "string" ||
    typeof expectedLock.version !== "string" ||
    typeof expectedLock.packages?.[""]?.version !== "string"
  ) {
    throw new Error("Trusted release metadata is missing a version field.");
  }
  expectedPackage.version = version;
  expectedLock.version = version;
  expectedLock.packages[""].version = version;
  for (const [relativePath, expected] of [
    ["package.json", expectedPackage],
    ["package-lock.json", expectedLock],
  ]) {
    try {
      deepStrictEqual(
        readJson(join(candidateDirectory, relativePath)),
        expected,
      );
    } catch {
      throw new Error(
        `Release candidate ${relativePath} changes metadata beyond its version.`,
      );
    }
  }

  for (const relativePath of RELEASE_FILES) {
    copyFileSync(
      join(candidateDirectory, relativePath),
      join(workspace, relativePath),
    );
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [releaseTag, artifactDirectory, workspaceDirectory] =
    process.argv.slice(2);
  if (!releaseTag || !artifactDirectory || !workspaceDirectory) {
    throw new Error(
      "Usage: validate-release-candidate.mjs RELEASE_TAG ARTIFACT_DIRECTORY WORKSPACE_DIRECTORY",
    );
  }
  validateAndStageCandidate({
    releaseTag,
    artifactDirectory,
    workspaceDirectory,
  });
}
