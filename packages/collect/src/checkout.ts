import { relative, resolve } from "node:path";
import {
  ARTIFACT_SCHEMA_VERSION,
  parseChangeArtifact,
  validatePathComponentBudget,
  type ArtifactSource,
  type FileOperation,
} from "../../shared/src/artifact";
import {
  assertExactCleanCheckout,
  assertExactHead,
  assertRootIdentity,
  assertTrustedPython,
  captureRootIdentity,
  captureTrustedPython,
  collectOperations,
  writeArtifact,
  type Execute,
  type RootIdentity,
} from "./git";

interface CheckoutOptions {
  workspace: string;
  workingDirectory: string;
  artifactDirectory: string;
  source: ArtifactSource;
  maxFiles: number;
  maxBytes: number;
}

export interface CheckoutDeps {
  execute: Execute;
  env: NodeJS.ProcessEnv;
  collectChanges?: (
    root: string,
    execute: Execute,
    env: NodeJS.ProcessEnv,
    expectedRoot: RootIdentity,
    maxFiles: number,
    maxBytes: number,
  ) => Promise<FileOperation[]>;
}

interface ReviewCheckout {
  runPass(
    args: string[],
    maxLogBytes: number,
    timeoutMs: number,
  ): Promise<{ exitCode: number; operations: FileOperation[] }>;
  persist(operations: FileOperation[]): Promise<string>;
}

export async function openCheckout(
  options: CheckoutOptions,
  { execute, env, collectChanges }: CheckoutDeps,
): Promise<ReviewCheckout> {
  const workspace = resolve(options.workspace);
  const workspaceIdentity = await captureRootIdentity(workspace);
  const artifactRoot = resolve(options.artifactDirectory);
  const artifactRootIdentity = await captureRootIdentity(artifactRoot);
  const trustedPython = await captureTrustedPython();
  const canonicalWorkspace = workspaceIdentity.canonicalPath;
  const rootPathname = resolve(canonicalWorkspace, options.workingDirectory);
  const rel = relative(canonicalWorkspace, rootPathname);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error("working-directory must be inside the workspace");
  }
  const workingRootIdentity = await captureRootIdentity(rootPathname);
  const canonicalRoot = workingRootIdentity.canonicalPath;
  const canonicalRel = relative(canonicalWorkspace, canonicalRoot);
  if (
    canonicalRel === ".." ||
    canonicalRel.startsWith("../") ||
    canonicalRel.startsWith("..\\")
  ) {
    throw new Error("working-directory must resolve inside the workspace");
  }
  await assertTrustedPython(trustedPython);
  const python = await execute(
    trustedPython.canonicalPath,
    ["-I", "-c", "import os, stat"],
    { cwd: canonicalWorkspace, env, captureLimitBytes: 4096 },
  );
  if (python.exitCode !== 0) {
    throw new Error("secure collection requires Python 3");
  }
  const { source, maxFiles, maxBytes } = options;
  await assertExactCleanCheckout(
    canonicalWorkspace,
    source.headSha,
    execute,
    env,
  );

  return {
    async runPass(args, maxLogBytes, timeoutMs) {
      await assertTrustedPython(trustedPython);
      // A returned result confirms descendant cleanup before checkout inspection.
      const result = await execute("prek", args, {
        cwd: canonicalRoot,
        env,
        streamUntrustedOutput: true,
        streamLimitBytes: maxLogBytes,
        superviseProcessTree: true,
        trustedPythonPath: trustedPython.canonicalPath,
        timeoutMs,
      });
      await assertRootIdentity(workspace, workspaceIdentity);
      await assertRootIdentity(rootPathname, workingRootIdentity);
      await assertExactHead(canonicalWorkspace, source.headSha, execute, env);
      const operations = collectChanges
        ? await collectChanges(
            canonicalWorkspace,
            execute,
            env,
            workspaceIdentity,
            maxFiles,
            maxBytes,
          )
        : await collectOperations(
            canonicalWorkspace,
            execute,
            env,
            maxFiles,
            maxBytes,
            0,
            workspaceIdentity,
            trustedPython,
          );
      return { exitCode: result.exitCode, operations };
    },

    async persist(operations) {
      await assertRootIdentity(workspace, workspaceIdentity);
      await assertRootIdentity(artifactRoot, artifactRootIdentity);
      await assertTrustedPython(trustedPython);
      await assertExactHead(canonicalWorkspace, source.headSha, execute, env);
      validatePathComponentBudget(operations.map(({ path }) => path));
      const artifact = parseChangeArtifact(
        { schemaVersion: ARTIFACT_SCHEMA_VERSION, source, operations },
        maxFiles,
        maxBytes,
      );
      const file = await writeArtifact(
        options.artifactDirectory,
        artifact,
        artifactRootIdentity,
      );
      await assertRootIdentity(workspace, workspaceIdentity);
      await assertRootIdentity(artifactRoot, artifactRootIdentity);
      await assertExactHead(canonicalWorkspace, source.headSha, execute, env);
      return file;
    },
  };
}
