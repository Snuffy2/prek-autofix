# Coding standards

Use these standards when writing or reviewing TypeScript and tests for
`prek-autofix`. See [AGENTS.md](AGENTS.md) for the repository layout,
[security invariants](AGENTS.md#security-invariants), and
[required validation](AGENTS.md#required-validation).

## TypeScript

- Write strict TypeScript and keep public boundaries explicitly typed.
- Prefer small, single-purpose functions and immutable data.
- Validate all external data before use, including action inputs, GitHub API
  responses, artifact content, paths, file modes, and size limits.
- Catch specific failures and return actionable error messages without exposing
  secrets.
- Keep imports at the top of each file and preserve useful comments.

## Test design guardrails

- Add or update focused Vitest coverage for every behavior change.
- Do not weaken a check merely to make a test pass.
- Never add tests that freeze incidental implementation or configuration
  details. Prohibited examples include exact dependency or Action versions,
  cache settings, step counts, cosmetic metadata, private helper structure,
  source-text or AST scans, and whole workflow/job snapshots.
- Do not turn a reviewer, linter, or security-tool preference into a test unless
  it is an explicit product requirement with an observable failure mode. In
  particular, never assert whether `actions/setup-node` caching is enabled or
  disabled unless cache behavior itself becomes part of the documented product
  contract.
- Assert observable behavior and durable security boundaries. Test ordering only
  when changing the order changes behavior, such as uploading a completed
  artifact before propagating a collection failure or performing a guarded
  compare-and-swap mutation.
- When an exact artifact is the supported contract, test only the smallest
  stable semantic property. Canonical-file equivalence checks are allowed when
  two published files must remain identical; do not duplicate the artifact's
  contents as a second policy mirror in test code.
- If a routine refactor, dependency update, Action update, or harmless workflow
  setting change breaks a test without changing product behavior, remove or
  replace the brittle test. Do not update its incidental literal and preserve
  the same coupling.
- Before adding a metadata or documentation test, state the user-visible or
  security failure it catches and why existing behavioral coverage is
  insufficient. If there is no concrete failure, do not add the test.
