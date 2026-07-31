import {
  ArtifactNotFoundError,
  DefaultArtifactClient,
  type GetArtifactResponse,
} from "@actions/artifact";
import * as core from "@actions/core";
import { artifactName } from "../../shared/src/artifact";

interface ArtifactLookupClient {
  getArtifact(
    name: string,
    options: Parameters<DefaultArtifactClient["getArtifact"]>[1],
  ): Promise<GetArtifactResponse>;
}

export async function getArtifactIfPresent(
  artifactClient: ArtifactLookupClient,
  runId: number,
  runAttempt: number,
  owner: string,
  repo: string,
  githubToken: string,
): Promise<GetArtifactResponse | undefined> {
  try {
    return await artifactClient.getArtifact(artifactName(runId, runAttempt), {
      findBy: {
        token: githubToken,
        workflowRunId: runId,
        repositoryOwner: owner,
        repositoryName: repo,
      },
    });
  } catch (error: unknown) {
    if (
      error instanceof ArtifactNotFoundError ||
      (error instanceof Error && error.name === "ArtifactNotFoundError")
    ) {
      core.info(
        `No ${artifactName(runId, runAttempt)} artifact was produced; nothing to apply.`,
      );
      return undefined;
    }
    throw error;
  }
}
