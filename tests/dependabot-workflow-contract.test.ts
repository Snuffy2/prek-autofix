import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step {
  readonly env?: Record<string, string>;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, boolean | string>;
}

interface Job {
  readonly if?: string;
  readonly needs?: string | string[];
  readonly permissions?: Record<string, string>;
  readonly steps?: Step[];
}

interface Workflow {
  readonly jobs: Record<string, Job>;
}

function workflow(path: string): Workflow {
  return parse(readFileSync(resolve(path), "utf8")) as Workflow;
}

function requiredSteps(job: Job): Step[] {
  expect(job.steps).toBeDefined();
  return job.steps!;
}

function authorizationStep(job: Job): Step {
  const step = requiredSteps(job).find((candidate) =>
    candidate.run?.includes(".github/scripts/dependabot-auto-merge.mjs"),
  );
  expect(step).toBeDefined();
  return step!;
}

function authorizationJobs(workflow: Workflow): [string, Job][] {
  return Object.entries(workflow.jobs).filter(([, job]) =>
    requiredSteps(job).some((step) =>
      step.run?.includes(".github/scripts/dependabot-auto-merge.mjs"),
    ),
  );
}

function trustedCheckoutBefore(job: Job): Step {
  const authorizationIndex = requiredSteps(job).indexOf(authorizationStep(job));
  const checkout = requiredSteps(job)
    .slice(0, authorizationIndex)
    .find(
      (candidate) =>
        candidate.uses?.startsWith("actions/checkout@") &&
        candidate.with?.ref === "${{ github.event.pull_request.base.sha }}",
    );
  expect(checkout).toBeDefined();
  expect(checkout!.with?.["persist-credentials"]).toBe(false);
  return checkout!;
}

function requiresEligibleDependabot(condition: string | undefined): void {
  const value = condition ?? "";
  for (const term of [
    "repository.fork == false",
    "pull_request.user.login == 'dependabot[bot]'",
    "pull_request.head.repo.full_name == github.repository",
    "pull_request.base.ref == github.event.repository.default_branch",
  ])
    expect(value).toContain(term);
}

function requiresDependabotAuthorOnly(condition: string | undefined): void {
  const value = condition ?? "";
  expect(value).toContain("pull_request.user.login == 'dependabot[bot]'");
  for (const provenanceGate of [
    "repository.fork",
    "pull_request.head.repo.full_name",
    "pull_request.base.ref",
  ])
    expect(value).not.toContain(provenanceGate);
}

function requiresDependabotPullRequest(condition: string | undefined): void {
  const value = condition ?? "";
  expect(value).toContain("github.event_name == 'pull_request'");
  expect(value).toContain("pull_request.user.login == 'dependabot[bot]'");
}

function needsOnlyJob(job: Job, jobName: string): boolean {
  return (
    job.needs === jobName ||
    (Array.isArray(job.needs) &&
      job.needs.length === 1 &&
      job.needs[0] === jobName)
  );
}

function assertsAuthoritativeDataflow(job: Job): void {
  const step = authorizationStep(job);
  const run = step.run!;
  expect(run).toMatch(/pulls.*files/);
  expect(run).toMatch(/pulls.*commits/);
  expect(run).toContain("compare/");
  expect(step.env?.BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
  expect(run).toContain("${BASE_SHA}");
}

describe("Dependabot workflow trust contracts", () => {
  it("uses trusted read-only authorization with PR files, commits, and ancestry evidence", () => {
    const autoMerge = workflow(".github/workflows/dependabot-auto-merge.yml");
    const ci = workflow(".github/workflows/ci.yml");
    const autoMergeAuthorization = authorizationJobs(autoMerge);
    const ciAuthorization = authorizationJobs(ci);
    expect(autoMergeAuthorization).toHaveLength(1);
    expect(ciAuthorization).toHaveLength(1);

    for (const [, job] of [...autoMergeAuthorization, ...ciAuthorization]) {
      expect(job.permissions).toMatchObject({
        "contents": "read",
        "pull-requests": "read",
      });
      trustedCheckoutBefore(job);
      assertsAuthoritativeDataflow(job);
    }

    const [, autoMergeJob] = autoMergeAuthorization[0]!;
    requiresDependabotAuthorOnly(autoMergeJob.if);
    const [, ciJob] = ciAuthorization[0]!;
    requiresDependabotPullRequest(trustedCheckoutBefore(ciJob).if);
    requiresDependabotPullRequest(authorizationStep(ciJob).if);
  });

  it("keeps write jobs dependent on successful authorization and checkout-free", () => {
    const autoMerge = workflow(".github/workflows/dependabot-auto-merge.yml");
    const authorization = authorizationJobs(autoMerge)[0];
    expect(authorization).toBeDefined();
    const [authorizationName] = authorization!;
    const writeJobs = Object.values(autoMerge.jobs).filter(
      (job) =>
        job.permissions?.contents === "write" ||
        job.permissions?.["pull-requests"] === "write",
    );
    expect(writeJobs).not.toHaveLength(0);
    expect(
      writeJobs.some(
        (job) => job.if === undefined && needsOnlyJob(job, authorizationName),
      ),
    ).toBe(true);

    for (const job of writeJobs)
      expect(
        requiredSteps(job).some((step) =>
          step.uses?.startsWith("actions/checkout@"),
        ),
      ).toBe(false);
  });

  it("uses cancellation-safe cleanup under the same eligibility guard", () => {
    const autoMerge = workflow(".github/workflows/dependabot-auto-merge.yml");
    const cleanup = Object.values(autoMerge.jobs).find((job) =>
      job.if?.includes("failure()"),
    );
    expect(cleanup).toBeDefined();
    const cleanupJob = cleanup!;
    expect(cleanupJob.if).toContain("failure()");
    expect(cleanupJob.if).toContain("!cancelled()");
    requiresEligibleDependabot(cleanupJob.if);
  });

  it("authorizes Dependabot PRs before CI checks out their head", () => {
    const ci = workflow(".github/workflows/ci.yml");
    const authorization = authorizationJobs(ci)[0];
    expect(authorization).toBeDefined();
    const [, job] = authorization!;
    const steps = requiredSteps(job);
    const authorizationIndex = steps.indexOf(authorizationStep(job));
    const headCheckoutIndex = steps.findIndex(
      (step, index) =>
        index > authorizationIndex &&
        step.uses?.startsWith("actions/checkout@"),
    );
    expect(headCheckoutIndex).toBeGreaterThan(authorizationIndex);
  });
});
