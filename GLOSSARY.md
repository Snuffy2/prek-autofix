# prek-autofix

The Action reviews pull requests with `prek` and applies stable mechanical fixes
to the branch under review. The review and fix workflows have separate roles.

## Language

### Review and collection

**Review workflow**: The read-only workflow that runs the pull request's hooks
and collects their proposed file changes.

**Source run**: The review workflow run whose completion triggered the fix
workflow. The source run attempt identifies which execution completed, including
after a rerun.

**Source commit**: The pull request head commit reviewed by the source run and
the starting point for its proposed changes.

**Current head**: The commit currently at the tip of the pull request branch. It
can advance after the source run reviewed the source commit.

**Hook finding**: An issue reported by a hook. A remaining finding still needs
attention after the hook's mechanical changes are made.

**Stable fixes**: Nonempty file changes left by `prek` that stop changing across
repeated passes. Stable fixes can coexist with remaining hook findings.

**Change artifact**: The review workflow's proposal to apply a set of file
changes to a specific source commit.

### Application and recovery

**Fix workflow**: The trusted workflow responsible for validating a change
artifact and applying its proposed changes to the pull request branch.

**Stale artifact**: A change artifact whose source commit no longer matches the
pull request's current head.

**Fix commit**: The commit that applies the change artifact's file changes on
top of the source commit.

**Recovery comment**: A pull request comment that explains why automatic
application was blocked and how to recover.
