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

1. **`prek-autofix review`** runs on `pull_request`, checks out the exact
   contributor commit without credentials, and runs repository-controlled hooks
   with only `contents: read`.
2. **`prek-autofix fix`** runs on `workflow_run` from the base repository's
   default branch. It never checks out or runs pull-request code. It checks the
   artifact and the pull request's current head, then uses a bot personal access
   token (PAT) only for the GitHub update.

Hooks are code supplied by the pull request, so they must never receive a token
that can update the branch.

## Requirements and limits

- Both workflow files must live on the base repository's default branch.
- Only regular and executable files are applied. Changes to symlinks,
  submodules, and `.github/workflows/**` are rejected.

## Quick start

### 1. Create the personal access token

Create a classic personal access token (PAT) from a GitHub account that already
has write access to the base repository:

| Repository visibility | Minimum classic PAT scope |
| --------------------- | ------------------------- |
| Public                | `public_repo`             |
| Private               | `repo`                    |

1. Open GitHub **Settings** → **Developer settings** → **Personal access
   tokens** → **Tokens (classic)**.
2. Select **Generate new token (classic)**, give the token a descriptive name,
   and choose an expiration.
3. Select `public_repo` for a public repository or `repo` for a private
   repository. Do **not** select `workflow`.
4. Generate the token and copy it.
5. In the base repository, open **Settings** → **Secrets and variables** →
   **Actions**. Create a repository secret named `PREK_AUTOFIX_TOKEN` and paste
   the token as its value.

Do not put the PAT in a workflow file, configuration file, or the Stage 1
environment. Workflow-file changes are reported but never applied automatically.

The token is needed because commits made with `GITHUB_TOKEN` do not reliably
start the fresh checks that confirm the resulting branch is clean.

### 2. Add the review workflow

Create `.github/workflows/prek-autofix-review.yml` following the example below.

<!-- prettier-ignore-start -->
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
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    outputs:
      changed: ${{ steps.review.outputs.changed }}
    steps:
      - uses: actions/checkout@v7
        with:
          repository: ${{ github.event.pull_request.head.repo.full_name }}
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 1
          persist-credentials: false

      - id: review
        uses: Snuffy2/prek-autofix/review@v1

  signal:
    needs: review
    if: needs.review.outputs.changed == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Report pending prek fixes
        run: exit 1
```
<!-- END prek-autofix-stage-1 -->
<!-- prettier-ignore-end -->

`review` uploads its versioned change artifact and succeeds after the upload.
The dependent `signal` job deliberately fails when fixes are waiting. That
expected failure is distinct from a collector, hook, infrastructure, or
non-convergence failure. The action installs and caches `prek`; do not add an
artifact action or a write token to this job.

Hooks configured with `language = "system"` use dependencies provided by the
calling workflow. Install those dependencies before the `review` step. For a
Node project with a committed `package-lock.json`, add this after checkout and
before `review`:

<!-- prettier-ignore-start -->
```yaml
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm

      - run: npm ci
```
<!-- prettier-ignore-end -->

`review` installs and caches `prek`; it does not install project dependencies.
Use your project's corresponding setup and locked install command for other
languages.

### 3. Add the fix workflow

Create `.github/workflows/prek-autofix-fix.yml`. Its `workflows` value must
match the Stage 1 workflow's `name` exactly: `prek-autofix`.

<!-- prettier-ignore-start -->
<!-- BEGIN prek-autofix-stage-2 -->
```yaml
name: prek-autofix fix

on:
  workflow_run:
    workflows: [prek-autofix]
    types: [completed]

permissions:
  actions: read
  contents: read
  pull-requests: write

concurrency:
  # prettier-ignore
  group: prek-autofix-fix-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: false

jobs:
  fix:
    if: >-
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-latest
    steps:
      - uses: Snuffy2/prek-autofix/fix@v1
        env:
          GITHUB_TOKEN: ${{ github.token }}
        with:
          autofix-token: ${{ secrets.PREK_AUTOFIX_TOKEN }}
          source-workflow: prek-autofix
```
<!-- END prek-autofix-stage-2 -->
<!-- prettier-ignore-end -->

Keep this workflow on the default branch. A `workflow_run` workflow uses the
base repository's trusted workflow definition even when the pull request comes
from a fork. Do not add `actions/checkout` or `git` commands to this workflow.

The complete, tested versions are also available as
[`examples/prek-autofix-review.yml`](examples/prek-autofix-review.yml) and
[`examples/prek-autofix-fix.yml`](examples/prek-autofix-fix.yml). The README
snippets are tested against those canonical files.

## What to expect

| Situation                                                                                         | Result                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Same-repository pull request with changes                                                         | Review uploads the changes, the signal job fails, the Action adds one fix commit, and that commit starts a fresh check. |
| User-owned fork with **Allow edits from maintainers** enabled                                     | The Action attempts the same non-force update.                                                                          |
| Fork without maintainer edits                                                                     | Review still runs. Fix leaves one persistent PR comment with the reason, artifact link, and recovery steps.             |
| Protected branch or denied update                                                                 | No force push or bypass. The persistent PR comment explains the denial and recovery.                                    |
| Hook fails but changes no files                                                                   | No commit is created; fix the hook failure normally.                                                                    |
| Hook leaves stable fixes but still fails                                                          | The artifact may be retained for diagnosis, but no automatic commit is created; fix the hook failure normally.          |
| Hooks do not converge within `max-passes`                                                         | No commit is created; resolve the interacting hooks or increase the limit deliberately.                                 |
| Stale source SHA, closed PR, wrong event, unsafe path, symlink/submodule, or workflow-file change | Fix rejects the change without updating the branch.                                                                     |

The initial check is supposed to fail when `prek` produces files to apply. The
PAT-authored commit starts a new `pull_request` run, which passes only after
`prek` completes without more changes. This Action never submits an approving
review, so normal approval and protection rules are unaffected.

## Configuration

`review` accepts these inputs:

| Input                  | Default       | Meaning                                                                              |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `prek-version`         | `latest`      | Version or supported version range to install                                        |
| `extra-args`           | `--all-files` | Arguments appended to `prek run`                                                     |
| `working-directory`    | `.`           | Directory in which to run `prek`                                                     |
| `cache`                | `true`        | Enable the official prek environment cache                                           |
| `max-passes`           | `3`           | Maximum convergence passes                                                           |
| `max-log-bytes`        | `1048576`     | Maximum bytes streamed from each of stdout and stderr per pass (1024–10485760)       |
| `pass-timeout-seconds` | `600`         | Timeout for each pass (1–3600 seconds); the hook process tree is terminated on Linux |

For example, replace the `review` step in Stage 1 with:

<!-- prettier-ignore-start -->
```yaml
      - uses: Snuffy2/prek-autofix/review@v1
        with:
          prek-version: 0.2.0
          extra-args: --all-files --show-diff-on-failure
          working-directory: tools
          cache: true
          max-passes: 2
          max-log-bytes: 1048576
          pass-timeout-seconds: 600
```
<!-- prettier-ignore-end -->

`fix` accepts these inputs:

| Input             | Default                                | Meaning                                                                       |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `autofix-token`   | Required                               | Classic PAT from an account with repository write access; use only in Stage 2 |
| `commit-message`  | `[prek-autofix] apply automatic fixes` | Commit message for the generated commit                                       |
| `source-workflow` | `prek-autofix`                         | Expected review workflow name                                                 |
| `max-files`       | `100`                                  | Maximum trusted changed files                                                 |
| `max-bytes`       | `10485760`                             | Maximum trusted total content bytes                                           |

To use a different commit message or tighter limits, extend the Stage 2 step:

<!-- prettier-ignore-start -->
```yaml
        with:
          autofix-token: ${{ secrets.PREK_AUTOFIX_TOKEN }}
          source-workflow: prek-autofix
          commit-message: "chore: apply prek fixes"
          max-files: 25
          max-bytes: 1048576
```
<!-- prettier-ignore-end -->

Quote YAML values with spaces or special characters. Start with the defaults
unless you have a measured need for smaller limits.

## Safety model

Stage 1 has only `contents: read`, checks out the exact pull-request head and
repository, and sets `persist-credentials: false`. Its hooks receive neither the
PAT nor a write-capable `GITHUB_TOKEN`.

On Linux, collection supervises hook processes and stops if it cannot confirm
that their child processes have ended before it inspects Git state or creates an
artifact. This protects the collection lifecycle; it is not a sandbox for
untrusted code. The collector also verifies the trusted Python interpreter and
workspace identity, then treats hook output as an untrusted patch.

Stage 2 requires a successful review job and the exact expected failure from the
dedicated signal job. It independently finds the open pull request and its
current head from GitHub rather than trusting artifact-supplied target metadata
or file content. It rejects stale or unsafe input, limits file count and content
size, excludes `.github/workflows/**`, and uses the PAT only for the validated
Git Data API update.

The final branch update is atomic: if the contributor pushed a new commit,
application stops instead of overwriting it. Stage 2 does not check out
pull-request code, invoke `git`, or run hooks. Its separate `GITHUB_TOKEN` is
used only for reads and PR comments with the permissions shown above.

## Troubleshooting and recovery

| Symptom                                            | Check and recovery                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No fix run or no artifact                          | Confirm both YAML files are on the default branch, the Stage 1 name is exactly `prek-autofix`, and the review log shows an artifact. Correct the configuration, then re-run Stage 1.                                                                  |
| `Resource not accessible` or token failure         | Confirm the secret name is exactly `PREK_AUTOFIX_TOKEN`, the account that created the PAT has repository write access, and the token's classic scope is `public_repo` (public) or `repo` (private). Never add the PAT to Stage 1 to work around this. |
| Fork update denied                                 | Ask the contributor to enable **Allow edits from maintainers**. They can also download the linked artifact and apply the changes themselves.                                                                                                          |
| Branch protection blocks the update                | Apply the artifact manually. Do not weaken protection or force-push for autofixes.                                                                                                                                                                    |
| First-time contributor workflow waits for approval | A maintainer must approve the initial `pull_request` workflow run in GitHub's Actions UI. No artifact exists until that read-only run is approved and completes.                                                                                      |
| Check keeps failing after the fix commit           | Read the new Stage 1 log. A hard hook failure or non-converging hooks produce no automatic commit and need a normal fix.                                                                                                                              |

## Pinning and upgrades

The examples intentionally use `Snuffy2/prek-autofix/review@v1` for review and
`Snuffy2/prek-autofix/fix@v1` for fixes. `v1` is a moving major tag. For higher
supply-chain assurance, pin both actions to a reviewed immutable release commit
SHA after each release. You can also pin third-party actions to a reviewed full
SHA if your repository policy requires it.

The collection implementation uses a major tag for `j178/prek-action` and
bundles its artifact dependencies in the release build; callers do not need to
reproduce those internal dependencies. Before upgrading, review the release
notes, runner requirements, and workflow permissions. For a major-action
upgrade, test one same-repository pull request and one user-owned fork with
maintainer edits enabled before rolling it out more broadly.

## Outputs

`review` exposes `changed`, `artifact-name`, and `prek-version` outputs.
`changed` says whether `prek` generated applicable changes; `artifact-name`
identifies the versioned change artifact; and `prek-version` is the installed
version. The standard two-workflow setup does not need to consume these directly
because `fix` resolves the originating workflow run itself.
