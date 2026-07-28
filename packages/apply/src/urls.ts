/** Build the GitHub Actions URL for a specific workflow artifact. */
export function workflowArtifactUrl(
  serverUrl: string,
  repository: string,
  runId: number,
  artifactId: number,
): string {
  return `${serverUrl}/${repository}/actions/runs/${runId}/artifacts/${artifactId}`;
}
