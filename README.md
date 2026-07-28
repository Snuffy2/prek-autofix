# prek-autofix

`prek-autofix` runs [`prek`](https://github.com/j178/prek) on pull requests and
applies only the resulting mechanical fixes in a separate, privileged workflow.
It is intended for GitHub.com repositories. The first release uses
GitHub-hosted Linux runners with Python 3; GitHub Enterprise Server needs
separate validation. Collection fails closed on other runner platforms or when
Python 3 is unavailable because secure changed-file reads use descriptor-relative
path traversal.

## What it does

The two workflows deliberately have different trust boundaries:

1. **`prek-autofix`** runs on `pull_request`, checks out the exact contributor
   commit without credentials, and runs repository-controlled hooks with only
   `contents: read`.
2. **`prek-autofix apply`** runs on `workflow_run` from the base repository's
   default branch. It never checks out or runs pull-request code. It validates
   the artifact and current pull-request head, then uses a bot PAT only for the
   Git Data API update.

This separation matters: hooks are code supplied by the pull request, while a
token that can update a branch must never be exposed to those hooks.

## Quick start

### 1. Create the bot credential

Create a dedicated machine-user account for this Action. Give that account
write access to the base repository, then create a classic PAT:

| Repository visibility | Minimum classic PAT scope |
| --- | --- |
| Public | `public_repo` |
| Private | `repo` |

Do **not** grant `workflow`. Workflow-file changes are reported but are never
applied automatically. Add the PAT as the repository secret
`PREK_AUTOFIX_TOKEN`; do not put it in a workflow file, configuration file, or
the Stage 1 environment.

The token is needed because commits made with `GITHUB_TOKEN` do not reliably
trigger the fresh checks that prove the resulting branch is clean.

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
  group: prek-autofix-${{ github.event.pull_request.head.repo.full_name }}-${{ github.event.pull_request.head.ref }}
  cancel-in-progress: true

jobs:
  collect:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          repository: ${{ github.event.pull_request.head.repo.full_name }}
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 1
          persist-credentials: false

      - uses: Snuffy2/prek-autofix/collect@v1
```
<!-- END prek-autofix-stage-1 -->

`collect` uploads its versioned change artifact itself. It installs and caches
`prek`; callers should not add an artifact action or a write token to this job.

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
base repository's trusted workflow definition, even when the original pull
request came from a fork. Do not add `actions/checkout` or `git` commands to
this workflow.

The same complete files are maintained at
[`examples/prek-autofix.yml`](examples/prek-autofix.yml) and
[`examples/prek-autofix-apply.yml`](examples/prek-autofix-apply.yml). The
README snippets are tested against those canonical files.

## Expected behavior

| Situation | Result |
| --- | --- |
| Same-repository pull request with changes | Failing collection check uploads changes; bot adds one fix commit; the resulting commit starts a fresh, normally passing check. |
| User-owned fork, **Allow edits from maintainers** enabled | The bot attempts the same non-force update. |
| Fork without maintainer edits | Collection still runs. Application leaves one persistent PR comment with the reason, artifact link, and recovery steps. |
| Protected branch or denied update | No force push or bypass. The persistent PR comment explains the denial and recovery. |
| Hook fails but changes no files | No commit is created; fix the hook failure normally. |
| Hook leaves stable fixes but still fails | The stable fixes are applied once; the fresh check remains failing so the underlying hook error is still visible. |
| Hooks do not converge within `max-passes` | No commit is created; resolve the interacting hooks or increase the limit deliberately. |
| Stale source SHA, closed PR, wrong event, unsafe path, symlink/submodule, or workflow-file change | The application is rejected without changing the branch. |

The initial check is expected to fail when `prek` produces files to apply. The
PAT-authored commit causes a new `pull_request` run, which passes only after
`prek` completes without further changes. Normal review approvals and branch
protection are unaffected; this Action never submits an approving review.

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

For a different commit message or tighter safety limits, extend the Stage 2
step as follows:

```yaml
        with:
          autofix-token: ${{ secrets.PREK_AUTOFIX_TOKEN }}
          source-workflow: prek-autofix
          commit-message: "chore: apply prek fixes"
          max-files: 25
          max-bytes: 1048576
```

Values with spaces or special characters should be quoted in YAML. Start with
the defaults unless the repository has a measured need for a smaller limit.

## Security model

Stage 1 has only `contents: read`, uses the exact PR head/repository, and sets
`persist-credentials: false`. Its hook processes receive neither the PAT nor a
write-capable `GITHUB_TOKEN`. The generated artifact describes proposed file
operations, not permission to mutate a branch.

Linux process supervision in Stage 1 is a fail-closed integrity control, not a
hostile-code sandbox. The collector pins its trusted Python interpreter and
workspace identities, adopts and reaps hook descendants, and requires a private
cleanup acknowledgement before it inspects Git state or creates an artifact. A
same-UID process can still send `SIGKILL` to abort the action; without the
cleanup acknowledgement, collection stops and no Stage 2 artifact is produced.

Stage 2 independently identifies the open pull request and its current head
from GitHub; it does not trust artifact-supplied target metadata. It rejects
stale or unsafe input, caps file count and content size, excludes
`.github/workflows/**`, and uses the PAT only for the validated Git Data API
mutation. The final ref update is an atomic compare-and-swap against the
validated source SHA, so a branch move aborts rather than resurrecting or
overwriting contributor commits. Its read/comment `GITHUB_TOKEN` is passed
separately with only the workflow permissions shown above. Because Stage 2
does not check out PR code, invoke `git`, or run hooks,
repository-controlled Git configuration and executables cannot access the PAT.

## Troubleshooting and recovery

| Symptom | Check and recovery |
| --- | --- |
| No application run or no artifact | Confirm both YAML files are on the default branch, the Stage 1 name is exactly `prek-autofix`, and the collection logs show an artifact. Re-run Stage 1 after correcting the configuration. |
| `Resource not accessible` or token failure | Confirm the secret name is exactly `PREK_AUTOFIX_TOKEN`, the bot is a collaborator, and its classic scope is `public_repo` (public) or `repo` (private). Never add the PAT to Stage 1 to work around this. |
| Fork update denied | Ask the contributor to enable **Allow edits from maintainers**. They can also download the linked artifact and apply the changes themselves. |
| Branch protection blocks the bot | Permit the bot's ordinary branch update if appropriate, or apply the artifact manually. Do not weaken protection or force-push for autofixes. |
| First-time contributor workflow waits for approval | A maintainer must approve the initial `pull_request` workflow run in GitHub's Actions UI. No artifact exists until that read-only run is approved and completes. |
| Check keeps failing after the bot commit | Read the new Stage 1 log. A hard hook failure without applicable changes or non-converging hooks produces no automatic commit; stable fixes may be applied once, but the underlying hook failure still needs a normal fix. |

## Pinning and upgrades

The examples intentionally use `Snuffy2/prek-autofix/collect@v1` and
`Snuffy2/prek-autofix/apply@v1` for the supported public interface. `v1` is a
moving major tag. For a higher supply-chain assurance level, pin both to a
reviewed immutable release commit SHA after each release, and pin every
third-party action to a reviewed full SHA as the Stage 1 checkout already does.

The collection implementation pins its `j178/prek-action` and artifact
dependencies in the release build; callers do not need to reproduce those
internal dependencies. Review release notes, required runner versions, and
workflow permissions before advancing any pin. Major-action upgrades can change
runner requirements and should be validated on one same-repository PR and one
user-owned fork with maintainer edits enabled before organization-wide rollout.

## Outputs

`collect` exposes `changed`, `artifact-name`, and `prek-version` outputs.
`changed` indicates whether `prek` generated applicable changes;
`artifact-name` identifies the versioned change artifact; and `prek-version`
is the resolved installed version. The canonical two-workflow setup does not
need to consume them directly because `apply` resolves the exact originating
workflow run itself.

## License

MIT. See [the implementation plan](docs/implementation-plan.md) for the
complete interface and validation design.
