# prek-autofix

The Action reviews pull requests with `prek` and applies stable mechanical fixes
to the branch under review. The review and fix workflows have separate roles.

## Language

### Review and collection

**Review workflow**: The read-only workflow that runs the pull request's hooks
and collects their proposed file changes.

**Source run**: The review workflow run that triggered the fix workflow.

**Source run attempt**: The particular execution of the source run that
triggered the fix workflow. A rerun starts a new attempt of the same run.

**Source commit**: The pull request head commit reviewed by the source run and
the starting point for its proposed changes.

**Current head**: The commit currently at the tip of the pull request branch. It
can advance after the source run reviewed the source commit.

**Hook finding**: An issue reported by a hook.

**Remaining finding**: A hook finding that persists after the mechanical fixes.

**Stable fixes**: Nonempty file changes left by `prek` that stop changing across
repeated passes. Stable fixes can coexist with remaining hook findings.

**Change artifact**: The review workflow's proposed file changes for a specific
source commit and source run attempt.

### Application and recovery

**Fix workflow**: The trusted workflow responsible for validating a change
artifact and applying its proposed changes to the pull request branch.

**Stale artifact**: A change artifact whose source commit no longer matches the
pull request's current head.

**Fix commit**: The commit containing the change artifact's file changes, with
the source commit as its parent. The fixes are applied when the pull request
branch advances to the fix commit.

**Fix status**: The `prek-autofix/fix` commit status that reports the fix
workflow's progress or outcome on the source commit.

**Recovery comment**: A pull request comment that explains why automatic
application was blocked and how to recover.
