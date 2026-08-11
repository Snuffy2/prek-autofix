export interface MutationCredential {
  token: string;
  usedGithubTokenFallback: boolean;
}

export function selectMutationToken(
  configuredToken: string,
  githubToken: string,
): MutationCredential {
  if (configuredToken !== "") {
    return { token: configuredToken, usedGithubTokenFallback: false };
  }
  return { token: githubToken, usedGithubTokenFallback: true };
}
