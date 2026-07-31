import type { getOctokit } from "@actions/github";

type Octokit = ReturnType<typeof getOctokit>;

export interface SourceJob {
  name: string;
  conclusion: string | null;
}

const REVIEW_JOB = "review";

export class IneligibleSourceJobsError extends Error {}

function isSourceJob(value: unknown): value is SourceJob {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "name" in value &&
    typeof value.name === "string" &&
    "conclusion" in value &&
    (typeof value.conclusion === "string" || value.conclusion === null)
  );
}

/**
 * Verify that collection completed successfully.
 *
 * The job result is a reliability boundary: collector or infrastructure
 * failures must never be mistaken for a successful artifact collection.
 */
export function assertEligibleSourceJobs(jobs: unknown): void {
  if (!Array.isArray(jobs) || !jobs.every(isSourceJob)) {
    throw new IneligibleSourceJobsError(
      "source workflow returned malformed jobs",
    );
  }

  const reviewJobs = jobs.filter((job) => job.name === REVIEW_JOB);
  if (reviewJobs.length !== 1) {
    throw new IneligibleSourceJobsError(
      "source workflow must contain exactly one review job",
    );
  }
  if (reviewJobs[0]!.conclusion !== "success") {
    throw new IneligibleSourceJobsError(
      "source review job did not complete successfully",
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
  const jobs = await octokit.paginate(
    octokit.rest.actions.listJobsForWorkflowRun,
    {
      owner,
      repo,
      run_id: runId,
      filter: "latest",
      per_page: 100,
    },
  );
  assertEligibleSourceJobs(jobs);
}
