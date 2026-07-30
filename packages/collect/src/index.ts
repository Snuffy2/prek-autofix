import * as core from "@actions/core";
import * as github from "@actions/github";
import { executeCommand, runCollect } from "./runner";

async function main(): Promise<void> {
  const payload = github.context.payload.pull_request;
  await runCollect(
    {
      eventName: github.context.eventName,
      runId: github.context.runId,
      repository: `${github.context.repo.owner}/${github.context.repo.repo}`,
      workflow: github.context.workflow,
      pullRequestNumber: payload?.number,
      headSha: payload?.head?.sha,
      workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
      artifactDirectory: process.env.RUNNER_TEMP ?? process.cwd(),
    },
    {
      extraArgs:
        process.env.PREK_AUTOFIX_EXTRA_ARGS ?? core.getInput("extra-args"),
      workingDirectory:
        process.env.PREK_AUTOFIX_WORKING_DIRECTORY ??
        core.getInput("working-directory"),
      maxPasses: Number(
        process.env.PREK_AUTOFIX_MAX_PASSES ?? core.getInput("max-passes"),
      ),
      maxLogBytes: Number(
        process.env.PREK_AUTOFIX_MAX_LOG_BYTES ??
          core.getInput("max-log-bytes"),
      ),
      passTimeoutSeconds: Number(
        process.env.PREK_AUTOFIX_PASS_TIMEOUT_SECONDS ??
          core.getInput("pass-timeout-seconds"),
      ),
    },
    {
      execute: executeCommand,
      env: process.env,
      setOutput: core.setOutput,
    },
  );
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
