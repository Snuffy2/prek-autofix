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
  },
];

describe("source workflow job eligibility", () => {
  it("accepts a successful review", () => {
    expect(() => assertEligibleSourceJobs(eligibleJobs())).not.toThrow();
  });

  it.each([
    { name: "null", jobs: null },
    { name: "an object", jobs: { name: "review", conclusion: "success" } },
    { name: "a string", jobs: "jobs" },
  ])("rejects malformed top-level payload: $name", ({ jobs }) => {
    expect(() => assertEligibleSourceJobs(jobs)).toThrow(
      IneligibleSourceJobsError,
    );
    expect(() => assertEligibleSourceJobs(jobs)).toThrow(
      "source workflow returned malformed jobs",
    );
  });

  it.each([
    { name: "null job", job: null },
    { name: "array job", job: [] },
    { name: "missing name", job: { conclusion: "success" } },
    { name: "non-string name", job: { name: 1, conclusion: "success" } },
    { name: "missing conclusion", job: { name: "review" } },
    { name: "invalid conclusion", job: { name: "review", conclusion: 1 } },
  ])("rejects malformed job fields: $name", ({ job }) => {
    expect(() => assertEligibleSourceJobs([job])).toThrow(
      IneligibleSourceJobsError,
    );
    expect(() => assertEligibleSourceJobs([job])).toThrow(
      "source workflow returned malformed jobs",
    );
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
        jobs.push({ ...jobs[0]! });
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

  it("loads only the requested run attempt through the read token", async () => {
    const listJobsForWorkflowRunAttempt = vi.fn();
    const paginate = vi.fn().mockResolvedValue(eligibleJobs());
    const octokit = {
      rest: { actions: { listJobsForWorkflowRunAttempt } },
      paginate,
    };

    await expect(
      verifySourceJobs(octokit as never, "base", "repo", 7, 3),
    ).resolves.toBeUndefined();
    expect(paginate).toHaveBeenCalledWith(listJobsForWorkflowRunAttempt, {
      owner: "base",
      repo: "repo",
      run_id: 7,
      attempt_number: 3,
      per_page: 100,
    });
  });

  it("rejects a malformed paginate response", async () => {
    const octokit = {
      rest: { actions: { listJobsForWorkflowRunAttempt: vi.fn() } },
      paginate: vi.fn().mockResolvedValue(null),
    };

    await expect(
      verifySourceJobs(octokit as never, "base", "repo", 7, 3),
    ).rejects.toBeInstanceOf(IneligibleSourceJobsError);
  });
});
