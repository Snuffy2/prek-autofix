import { describe, expect, it, vi } from "vitest";
import {
  assertEligibleSourceJobs,
  IneligibleSourceJobsError,
  verifySourceJobs,
} from "../../packages/apply/src/source-jobs";

const eligibleJobs = () => [
  {
    name: "review",
    conclusion: "success",
    steps: [{ name: "Review prek fixes", conclusion: "success" }],
  },
];

describe("source workflow job eligibility", () => {
  it("accepts a successful review", () => {
    expect(() => assertEligibleSourceJobs(eligibleJobs())).not.toThrow();
  });

  it.each([
    {
      name: "review failure",
      mutate: (jobs: ReturnType<typeof eligibleJobs>) => {
        jobs[0]!.conclusion = "failure";
      },
      message: "review job did not complete successfully",
    },
    {
      name: "duplicate review",
      mutate: (jobs: ReturnType<typeof eligibleJobs>) => {
        jobs.push({ ...jobs[0]!, steps: [...jobs[0]!.steps] });
      },
      message: "exactly one review job",
    },
    {
      name: "missing review",
      mutate: (jobs: ReturnType<typeof eligibleJobs>) => {
        jobs.splice(0);
      },
      message: "exactly one review job",
    },
  ])("rejects $name", ({ mutate, message }) => {
    const jobs = eligibleJobs();
    mutate(jobs);
    expect(() => assertEligibleSourceJobs(jobs)).toThrow(message);
    expect(() => assertEligibleSourceJobs(jobs)).toThrow(
      IneligibleSourceJobsError,
    );
  });

  it("loads only the latest run attempt through the read token", async () => {
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn().mockResolvedValue(eligibleJobs());
    const octokit = {
      rest: { actions: { listJobsForWorkflowRun } },
      paginate,
    };

    await expect(
      verifySourceJobs(octokit as never, "base", "repo", 7),
    ).resolves.toBeUndefined();
    expect(paginate).toHaveBeenCalledWith(listJobsForWorkflowRun, {
      owner: "base",
      repo: "repo",
      run_id: 7,
      filter: "latest",
      per_page: 100,
    });
  });
});
