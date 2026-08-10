export interface MutationCredential {
  token: string;
  isBuiltIn: boolean;
}

export function selectMutationToken(
  configuredToken: string,
  githubToken: string,
): MutationCredential {
  const token = configuredToken || githubToken;
  return { token, isBuiltIn: token === githubToken };
}
