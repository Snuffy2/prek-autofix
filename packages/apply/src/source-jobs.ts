import type { getOctokit } from "@actions/github";

type Octokit = ReturnType<typeof getOctokit>;

export interface SourceJobStep {
  name: string;
  conclusion: string | null;
}

export interface SourceJob {
  name: string;
  conclusion: string | null;
  steps?: SourceJobStep[] | null;
}

const COLLECT_JOB = "collect";
const SIGNAL_JOB = "signal";
const SIGNAL_STEP = "Report pending prek fixes";

export class IneligibleSourceJobsError extends Error {}

/**
 * Verify that the source workflow failed for the expected autofix signal.
 *
 * The job result is a reliability boundary: collector or infrastructure
 * failures must never be mistaken for the intentional "fixes available"
 * failure emitted by the signal job.
 */
export function assertEligibleSourceJobs(jobs: SourceJob[]): void {
  const collectors = jobs.filter((job) => job.name === COLLECT_JOB);
  const signals = jobs.filter((job) => job.name === SIGNAL_JOB);
  if (collectors.length !== 1 || signals.length !== 1) {
    throw new IneligibleSourceJobsError(
      "source workflow must contain exactly one collect job and one signal job",
    );
  }
  if (collectors[0]!.conclusion !== "success") {
    throw new IneligibleSourceJobsError(
      "source collect job did not complete successfully",
    );
  }
  if (signals[0]!.conclusion !== "failure") {
    throw new IneligibleSourceJobsError(
      "source signal job did not report pending fixes",
    );
  }
  const reportingSteps = (signals[0]!.steps ?? []).filter(
    (step) => step.name === SIGNAL_STEP,
  );
  if (
    reportingSteps.length !== 1 ||
    reportingSteps[0]!.conclusion !== "failure"
  ) {
    throw new IneligibleSourceJobsError(
      "source signal job did not fail in the expected step",
    );
  }
}

/** Load and verify the latest-attempt jobs for a source workflow run. */
export async function verifySourceJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
): Promise<void> {
  const jobs = (await octokit.paginate(
    octokit.rest.actions.listJobsForWorkflowRun,
    {
      owner,
      repo,
      run_id: runId,
      filter: "latest",
      per_page: 100,
    },
  )) as SourceJob[];
  assertEligibleSourceJobs(jobs);
}
