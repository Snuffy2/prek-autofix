# prek-autofix

Stop spending review time on routine formatting fixes. `prek-autofix` runs
[`prek`](https://github.com/j178/prek) on every pull request, then adds one bot
commit with the resulting mechanical changes when it is safe to do so. Your
normal reviews, approvals, and branch protections stay in charge.

It uses two GitHub Actions workflows. The first runs the pull request's hooks
without write credentials. The second, trusted workflow checks the result and
applies it. This keeps a token that can update a branch away from pull-request
code.

## How it works

1. **`prek-autofix`** runs on `pull_request`, checks out the exact contributor
   commit without credentials, and runs repository-controlled hooks with only
   `contents: read`.
2. **`prek-autofix apply`** runs on `workflow_run` from the base repository's
   default branch. It never checks out or runs pull-request code. It checks the
   artifact and the pull request's current head, then uses a bot personal access
   token (PAT) only for the GitHub update.

Hooks are code supplied by the pull request, so they must never receive a token
that can update the branch. The artifact is a proposed set of file changes; it
does not grant permission to apply them.

## Requirements and limits

- This first release is for GitHub.com repositories using GitHub-hosted Linux
  runners. Keep `runs-on: ubuntu-latest` in the collection workflow. Collection
  also requires the runner's trusted `/usr/bin/python3`; if this is unavailable
  or the runner is not Linux, collection stops without creating an artifact.
- GitHub Enterprise Server has not yet been validated.
- Both workflow files must live on the base repository's default branch.
- You need a dedicated machine-user account with ordinary write access to the
  base repository. It must not have a branch-protection bypass.
- Only regular and executable files are applied. Changes to symlinks,
  submodules, and `.github/workflows/**` are rejected.

## Quick start

### 1. Create the bot credential

Create a dedicated machine-user account for this Action. Give it write access
to the base repository, then create a classic PAT:

| Repository visibility | Minimum classic PAT scope |
| --- | --- |
| Public | `public_repo` |
| Private | `repo` |

Do **not** grant `workflow`. Workflow-file changes are reported but never
applied automatically. Add the PAT as the repository secret
`PREK_AUTOFIX_TOKEN`. Do not put it in a workflow file, configuration file, or
the Stage 1 environment.

The token is needed because commits made with `GITHUB_TOKEN` do not reliably
start the fresh checks that confirm the resulting branch is clean.

### 2. Add the collection workflow

Create `.github/workflows/prek-autofix.yml` with this exact content. The
checkout is intentionally pinned to the current reviewed immutable
`actions/checkout` v6.1.0 commit; refresh that pin through your dependency
review process.

<!-- BEGIN prek-autofix-stage-1 -->
```yaml
name: prek-autofix

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

concurrency:
  group: prek-autofix-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  collect:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    outputs:
      changed: ${{ steps.collect.outputs.changed }}
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          repository: ${{ github.event.pull_request.head.repo.full_name }}
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 1
          persist-credentials: false

      - id: collect
        uses: Snuffy2/prek-autofix/collect@v1

  signal:
    needs: collect
    if: needs.collect.outputs.changed == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Report pending prek fixes
        run: exit 1
```
<!-- END prek-autofix-stage-1 -->

`collect` uploads its versioned change artifact and succeeds after the upload.
The dependent `signal` job deliberately fails when fixes are waiting. That
expected failure is distinct from a collector, hook, infrastructure, or
non-convergence failure. The action installs and caches `prek`; do not add an
artifact action or a write token to this job.

### 3. Add the application workflow

Create `.github/workflows/prek-autofix-apply.yml`. Its `workflows` value must
match the Stage 1 workflow's `name` exactly: `prek-autofix`.

<!-- BEGIN prek-autofix-stage-2 -->
```yaml
name: prek-autofix apply

on:
  workflow_run:
    workflows: [prek-autofix]
    types: [completed]

permissions:
  actions: read
  contents: read
  pull-requests: write

concurrency:
  group: prek-autofix-apply-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: false

jobs:
  apply:
    if: >-
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-latest
    steps:
      - uses: Snuffy2/prek-autofix/apply@v1
        env:
          GITHUB_TOKEN: ${{ github.token }}
        with:
          autofix-token: ${{ secrets.PREK_AUTOFIX_TOKEN }}
          source-workflow: prek-autofix
```
<!-- END prek-autofix-stage-2 -->

Keep this workflow on the default branch. A `workflow_run` workflow uses the
base repository's trusted workflow definition even when the pull request comes
from a fork. Do not add `actions/checkout` or `git` commands to this workflow.

The complete, tested versions are also available as
[`examples/prek-autofix.yml`](examples/prek-autofix.yml) and
[`examples/prek-autofix-apply.yml`](examples/prek-autofix-apply.yml). The
README snippets are tested against those canonical files.

## What to expect

| Situation | Result |
| --- | --- |
| Same-repository pull request with changes | Collection uploads the changes, the signal job fails, the bot adds one fix commit, and that commit starts a fresh check. |
| User-owned fork with **Allow edits from maintainers** enabled | The bot attempts the same non-force update. |
| Fork without maintainer edits | Collection still runs. Application leaves one persistent PR comment with the reason, artifact link, and recovery steps. |
| Protected branch or denied update | No force push or bypass. The persistent PR comment explains the denial and recovery. |
| Hook fails but changes no files | No commit is created; fix the hook failure normally. |
| Hook leaves stable fixes but still fails | The artifact may be retained for diagnosis, but no automatic commit is created; fix the hook failure normally. |
| Hooks do not converge within `max-passes` | No commit is created; resolve the interacting hooks or increase the limit deliberately. |
| Stale source SHA, closed PR, wrong event, unsafe path, symlink/submodule, or workflow-file change | Application rejects the change without updating the branch. |

The initial check is supposed to fail when `prek` produces files to apply. The
PAT-authored commit starts a new `pull_request` run, which passes only after
`prek` completes without more changes. This Action never submits an approving
review, so normal approval and protection rules are unaffected.

## Configuration

`collect` accepts these inputs:

| Input | Default | Meaning |
| --- | --- | --- |
| `prek-version` | `latest` | Version or supported version range to install |
| `extra-args` | `--all-files` | Arguments appended to `prek run` |
| `working-directory` | `.` | Directory in which to run `prek` |
| `cache` | `true` | Enable the official prek environment cache |
| `max-passes` | `3` | Maximum convergence passes |
| `max-log-bytes` | `1048576` | Maximum bytes streamed from each of stdout and stderr per pass (1024–10485760) |
| `pass-timeout-seconds` | `600` | Timeout for each pass (1–3600 seconds); the hook process tree is terminated on Linux |

For example, replace the `collect` step in Stage 1 with:

```yaml
      - uses: Snuffy2/prek-autofix/collect@v1
        with:
          prek-version: 0.2.0
          extra-args: --all-files --show-diff-on-failure
          working-directory: tools
          cache: true
          max-passes: 2
          max-log-bytes: 1048576
          pass-timeout-seconds: 600
```

`apply` accepts these inputs:

| Input | Default | Meaning |
| --- | --- | --- |
| `autofix-token` | Required | Dedicated bot PAT; use only in Stage 2 |
| `commit-message` | `[prek-autofix] apply automatic fixes` | Commit message for the generated commit |
| `source-workflow` | `prek-autofix` | Expected collection workflow name |
| `max-files` | `100` | Maximum trusted changed files |
| `max-bytes` | `10485760` | Maximum trusted total content bytes |

To use a different commit message or tighter limits, extend the Stage 2 step:

```yaml
        with:
          autofix-token: ${{ secrets.PREK_AUTOFIX_TOKEN }}
          source-workflow: prek-autofix
          commit-message: "chore: apply prek fixes"
          max-files: 25
          max-bytes: 1048576
```

Quote YAML values with spaces or special characters. Start with the defaults
unless you have a measured need for smaller limits.

## Safety model

Stage 1 has only `contents: read`, checks out the exact pull-request head and
repository, and sets `persist-credentials: false`. Its hooks receive neither
the PAT nor a write-capable `GITHUB_TOKEN`.

On Linux, collection supervises hook processes and stops if it cannot confirm
that their child processes have ended before it inspects Git state or creates
an artifact. This protects the collection lifecycle; it is not a sandbox for
untrusted code. The collector also verifies the trusted Python interpreter and
workspace identity, then treats hook output as an untrusted patch.

Stage 2 requires a successful collector job and the exact expected failure from
the dedicated signal job. It independently finds the open pull request and its
current head from GitHub rather than trusting artifact-supplied target metadata
or file content. It rejects stale or unsafe input, limits file count and
content size, excludes `.github/workflows/**`, and uses the PAT only for the
validated Git Data API update.

The final branch update is atomic: if the contributor pushed a new commit,
application stops instead of overwriting it. Stage 2 does not check out
pull-request code, invoke `git`, or run hooks. Its separate `GITHUB_TOKEN` is
used only for reads and PR comments with the permissions shown above.

## Troubleshooting and recovery

| Symptom | Check and recovery |
| --- | --- |
| No application run or no artifact | Confirm both YAML files are on the default branch, the Stage 1 name is exactly `prek-autofix`, the runner meets the requirements above, and the collection log shows an artifact. Correct the configuration, then re-run Stage 1. |
| `Resource not accessible` or token failure | Confirm the secret name is exactly `PREK_AUTOFIX_TOKEN`, the bot is a collaborator, and its classic scope is `public_repo` (public) or `repo` (private). Never add the PAT to Stage 1 to work around this. |
| Fork update denied | Ask the contributor to enable **Allow edits from maintainers**. They can also download the linked artifact and apply the changes themselves. |
| Branch protection blocks the bot | Permit the bot's ordinary branch update if appropriate, or apply the artifact manually. Do not weaken protection or force-push for autofixes. |
| First-time contributor workflow waits for approval | A maintainer must approve the initial `pull_request` workflow run in GitHub's Actions UI. No artifact exists until that read-only run is approved and completes. |
| Check keeps failing after the bot commit | Read the new Stage 1 log. A hard hook failure or non-converging hooks produce no automatic commit and need a normal fix. |

## Pinning and upgrades

The examples intentionally use `Snuffy2/prek-autofix/collect@v1` and
`Snuffy2/prek-autofix/apply@v1` as the supported public interface. `v1` is a
moving major tag. For higher supply-chain assurance, pin both to a reviewed
immutable release commit SHA after each release. Pin third-party actions to a
reviewed full SHA too, as the Stage 1 checkout already does.

The collection implementation pins its `j178/prek-action` and artifact
dependencies in the release build; callers do not need to reproduce those
internal dependencies. Before upgrading, review the release notes, runner
requirements, and workflow permissions. For a major-action upgrade, test one
same-repository pull request and one user-owned fork with maintainer edits
enabled before rolling it out more broadly.

## Outputs

`collect` exposes `changed`, `artifact-name`, and `prek-version` outputs.
`changed` says whether `prek` generated applicable changes; `artifact-name`
identifies the versioned change artifact; and `prek-version` is the installed
version. The standard two-workflow setup does not need to consume these
directly because `apply` resolves the originating workflow run itself.

## License

MIT. See [the implementation plan](docs/implementation-plan.md) for the full
interface and validation design.
