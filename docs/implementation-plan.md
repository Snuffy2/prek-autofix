# Prek Autofix GitHub Action

## Summary

Build `prek-autofix` as a two-stage GitHub Action that runs `prek` on pull
request code with read-only permissions, then applies generated fixes from a
separate privileged workflow.

Use the existing
[`j178/prek-action`](https://github.com/j178/prek-action) for installation and
caching. The separation is necessary because hooks execute
repository-controlled code, while fork updates require a write credential.
GitHub only permits fork updates when the contributor enables maintainer edits,
and `GITHUB_TOKEN` alone cannot reliably retrigger checks. The write stage
therefore uses a dedicated machine-user personal access token (PAT).

Relevant GitHub behavior is documented in:

- [Allowing changes to a pull request branch created from a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork)
- [How `GITHUB_TOKEN` triggers workflow runs](https://docs.github.com/en/actions/concepts/security/github_token)
- [Git database REST API](https://docs.github.com/en/rest/git)

## Architecture

### Stage 1: collect fixes

The unprivileged `pull_request` workflow will:

1. Check out the exact pull request head with persisted credentials disabled.
2. Require a clean checkout.
3. Install `prek` through a commit-pinned release of `j178/prek-action`.
4. Run `prek run --show-diff-on-failure --color=always --all-files`, repeating
   up to three passes so interacting hooks can converge.
5. Encode resulting additions, modifications, deletions, executable modes, and
   binary contents in a versioned JSON artifact.
6. Leave the check failing when fixes await application. It passes only when
   `prek` succeeds without producing changes.

This workflow receives only `contents: read`. No write token or repository
secret is exposed to pull request code or hook processes.

### Stage 2: apply fixes

The privileged `workflow_run` workflow will:

1. Run from the base repository's trusted default-branch workflow definition.
2. Retrieve the change artifact from the exact originating workflow run.
3. Independently resolve the associated open pull request and derive its head
   repository, branch, and current SHA from GitHub. Artifact-supplied target
   metadata is never authoritative.
4. Reject stale SHAs, unexpected workflow events, path traversal, symlinks,
   submodules, workflow-file changes, more than 100 changed files, or more than
   10 MiB of content.
5. Create blobs, a tree, and one
   `[prek-autofix] apply automatic fixes` commit through GitHub's Git Data API.
6. Update the pull request branch without force and only if its head still
   matches the validated source SHA.

The privileged workflow must not check out pull request code, execute hooks, or
invoke `git`. This prevents repository-controlled Git configuration, filters,
hooks, or executables from accessing the PAT.

### Authentication and fork behavior

Use a dedicated bot account PAT stored as `PREK_AUTOFIX_TOKEN`:

- The bot must have write access to the base repository.
- Public repositories use the classic `public_repo` scope.
- Private repositories require the classic `repo` scope.
- Do not grant the `workflow` scope. Changes under `.github/workflows/**` are
  reported but not automatically applied.

Auto-apply every eligible result. Fork application is necessarily best-effort:
the fork must be user-owned, the contributor must enable **Allow edits from
maintainers**, and branch protection must permit the update.

When GitHub prevents an update, update one persistent pull request comment with
the reason, the generated artifact link, and recovery instructions. Do not
submit an approving pull request review; this Action applies mechanical fixes
while normal review and branch-protection requirements remain intact.

## Public interface

### `collect` Action

Inputs:

| Input | Default | Purpose |
| --- | --- | --- |
| `prek-version` | `latest` | Version or supported version range to install |
| `extra-args` | `--all-files` | Arguments appended to `prek run` |
| `working-directory` | `.` | Directory in which to run `prek` |
| `cache` | `true` | Enable the official prek environment cache |
| `max-passes` | `3` | Maximum convergence passes |
| `max-log-bytes` | `1048576` | Maximum bytes streamed from each of stdout and stderr per pass (1024–10485760) |
| `pass-timeout-seconds` | `600` | Timeout for each pass (1–3600 seconds) |

Outputs:

| Output | Purpose |
| --- | --- |
| `changed` | Whether `prek` generated applicable changes |
| `artifact-name` | Name of the uploaded change artifact |
| `prek-version` | Resolved version of `prek` |

### `apply` Action

Inputs:

| Input | Default | Purpose |
| --- | --- | --- |
| `autofix-token` | Required | Dedicated bot PAT |
| `commit-message` | `[prek-autofix] apply automatic fixes` | Fix commit message |
| `source-workflow` | `prek-autofix` | Expected Stage 1 workflow name |
| `max-files` | `100` | Trusted changed-file limit |
| `max-bytes` | `10485760` | Trusted total-content limit |

The artifact schema includes a schema version, source run/PR/SHA metadata, and
normalized file operations. The apply stage derives and verifies all mutation
targets independently.

## Documentation and examples deliverable

A robust README is a release requirement, not a follow-up task. Before `v1`,
the README must give a new adopter a complete, copy-and-paste integration
without requiring them to infer permissions, event wiring, checkout behavior,
or token placement.

The repository will include both inline README examples and complete files under
`examples/`:

- `examples/prek-autofix.yml`: the read-only `pull_request` collection workflow.
- `examples/prek-autofix-apply.yml`: the privileged `workflow_run` application
  workflow.
- An optional reusable-workflow example for organizations that centralize
  Actions configuration.

The README and examples must comprehensively document:

1. Creating a dedicated bot account and PAT, selecting the minimum scope, adding
   the bot as a repository collaborator, and storing the PAT as
   `PREK_AUTOFIX_TOKEN`.
2. The exact two-workflow flow, including matching workflow names and why
   `workflow_run` is required.
3. Required permissions for each workflow:
   - Stage 1: `contents: read`.
   - Stage 2: `actions: read`, `contents: read`, and
     `pull-requests: write`, with the PAT used only for the Git Data mutation.
4. Checking out `${{ github.event.pull_request.head.sha }}` from
   `${{ github.event.pull_request.head.repo.full_name }}` with
   `persist-credentials: false`.
5. Pinning `prek-autofix`, `j178/prek-action`, checkout, and artifact
   dependencies to reviewed releases or commit SHAs.
6. Expected behavior for:
   - Same-repository pull requests.
   - User-owned fork pull requests with maintainer edits enabled.
   - Forks without maintainer edits.
   - Protected branches and stale workflow runs.
   - Hooks that fail without changing files.
   - Hooks that do not converge.
7. How the initial failing check transitions to a PAT-authored fix commit and a
   fresh passing check run.
8. Security boundaries: why the PAT is absent from Stage 1, why Stage 2 does not
   check out code or use `git`, and why workflow-file changes are excluded.
9. Configuration examples for custom `prek` versions, hook arguments, working
   directories, commit messages, and safety limits.
10. Troubleshooting instructions for missing artifacts, denied fork updates,
    token-scope failures, branch protection, and GitHub's first-time-contributor
    workflow approval.

Documentation tests will parse the checked-in example workflows, run
`actionlint`, and verify that the README snippets remain synchronized with the
canonical files.

## Implementation details

- Implement both Actions in TypeScript targeting the GitHub Actions Node 24
  runtime and commit their bundled distributions.
- Keep the collection runner and privileged applier in separate packages or
  entry points so credential-bearing code cannot accidentally invoke the hook
  runner.
- Pin the internal `j178/prek-action` dependency to a reviewed commit and
  automate dependency-update proposals.
- Add concurrency keyed by source repository and branch. A stale run exits
  without changing the branch.
- Use one marker-bearing pull request comment and update it instead of posting
  repeated comments.
- Publish immutable release tags and maintain moving major tags only after the
  corresponding immutable release succeeds.

## Test plan

- Unit-test repeated `prek` passes and clean, fixed, hard-failure, and
  non-converging outcomes.
- Test artifact handling for text, binary, executable, added, deleted, and
  renamed files.
- Test every privileged validation boundary: forged targets, stale SHA, closed
  pull request, wrong workflow, path traversal, symlink/submodule,
  workflow-file changes, and size limits.
- Mock the GitHub API to verify blob/tree/commit creation, non-forced ref
  updates, same-repository pull requests, eligible forks, denied maintainer
  edits, branch protection, and race conflicts.
- Verify the PAT is absent from the collection workflow, child-process
  environments, artifacts, and logs.
- Run action metadata, TypeScript, bundle reproducibility, lint, workflow
  contract, documentation-snippet synchronization, and `actionlint` checks in
  CI.
- Before `v1`, validate in disposable repositories with one same-repository
  pull request and one user-owned fork pull request with maintainer edits
  enabled.

## Initial assumptions

- Version one targets GitHub-hosted Linux runners and regular Git repositories.
- Regular and executable files are supported; symlink and submodule changes are
  rejected.
- The project is a standalone MIT-licensed companion to `j178/prek-action`, not
  a replacement for it.
- The initial release supports GitHub.com. GitHub Enterprise Server support
  requires separate compatibility validation.
