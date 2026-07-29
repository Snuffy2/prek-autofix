import { describe, expect, it, vi } from "vitest";
import {
  assertEligibleSourceJobs,
  IneligibleSourceJobsError,
  verifySourceJobs,
} from "../../packages/apply/src/source-jobs";

const eligibleJobs = () => [
  {
    name: "collect",
    conclusion: "success",
    steps: [{ name: "Collect prek autofixes", conclusion: "success" }],
  },
  {
    name: "signal",
    conclusion: "failure",
    steps: [{ name: "Report pending prek fixes", conclusion: "failure" }],
  },
];

describe("source workflow job eligibility", () => {
  it("accepts a successful collector and the expected failing signal", () => {
    expect(() => assertEligibleSourceJobs(eligibleJobs())).not.toThrow();
  });

  it.each([
    {
      name: "collector failure",
      mutate: (jobs: ReturnType<typeof eligibleJobs>) => {
        jobs[0]!.conclusion = "failure";
      },
      message: "collect job did not complete successfully",
    },
    {
      name: "signal success",
      mutate: (jobs: ReturnType<typeof eligibleJobs>) => {
        jobs[1]!.conclusion = "success";
      },
      message: "signal job did not report pending fixes",
    },
    {
      name: "wrong failing step",
      mutate: (jobs: ReturnType<typeof eligibleJobs>) => {
        jobs[1]!.steps[0]!.name = "Unexpected failure";
      },
      message: "signal job did not fail in the expected step",
    },
    {
      name: "duplicate collector",
      mutate: (jobs: ReturnType<typeof eligibleJobs>) => {
        jobs.push({ ...jobs[0]!, steps: [...jobs[0]!.steps] });
      },
      message: "exactly one collect job and one signal job",
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
