# AGENTS.md

## Purpose

`prek-autofix` is a TypeScript GitHub Action that runs `prek` against pull
requests and safely applies mechanical fixes. Changes must preserve the trust
boundary between the unprivileged review workflow and the privileged fix
workflow.

The overall behavior must match the safe working-tree effects of running
`prek run --all-files` locally. If hooks leave a stable, nonempty, validated
set of changes, apply those changes even when other hook findings remain
unfixable and `prek` exits nonzero. A new review run on the generated commit
must report the remaining findings. Continue to fail closed when no changes
were produced, changes do not converge, collection fails, or the artifact
violates a security invariant.

## Repository layout

- `packages/collect/src/` runs hooks without write credentials and creates the
  change artifact.
- `packages/apply/src/` validates a completed collection run and applies an
  approved artifact through the GitHub API.
- `packages/shared/src/` contains the artifact format and shared validation.
- `action.yml` and `review/action.yml` define the same public review Action
  interface; `fix/action.yml` defines the privileged fix Action interface.
- `dist/collect/index.js` and `dist/apply/index.js` are generated, committed
  release bundles.
- `examples/` contains the canonical consumer workflows.
- `tests/` mirrors the source areas and includes documentation and workflow
  contract tests.
- `docs/implementation-plan.md` records the detailed design and security model.

## Development environment

- Use Node.js 24 or newer.
- Install the exact locked dependencies with `npm ci`.
- Keep dependency and tool configuration in `package.json`,
  `package-lock.json`, `tsconfig.json`, and `eslint.config.mjs`.
- Do not edit files under `node_modules/`.

## Required validation

Run the checks that match the change:

```sh
npm run typecheck
npm run lint
npm test
npm run check:dist
```

Use the full set before completing a source, dependency, Action metadata, or
workflow change. A documentation-only change may use the relevant tests plus
`git diff --check`; README workflow examples must still pass
`tests/docs/workflows.test.ts`.

`npm run check:dist` rebuilds both bundles and fails if the committed `dist/`
files are stale. When source changes affect a bundle, commit the regenerated
bundle with the source change.

## Code conventions

- Write strict TypeScript and keep public boundaries explicitly typed.
- Prefer small, single-purpose functions and immutable data.
- Validate all external data before use, including action inputs, GitHub API
  responses, artifact content, paths, file modes, and size limits.
- Catch specific failures and return actionable error messages without exposing
  secrets.
- Keep imports at the top of each file and preserve useful comments.
- Add or update focused Vitest coverage for every behavior change.
- Do not weaken a check merely to make a test pass.

## Security invariants

Treat these rules as part of the product contract:

- Review runs pull-request-controlled code with read-only repository permission
  and without the autofix token.
- Fix never checks out pull-request code, invokes `git`, or runs hooks.
- The autofix token is used only after the workflow run, artifact, pull
  request, current head, paths, file modes, and limits have been validated.
- Branch updates remain non-force, atomic, and tied to the validated source
  commit.
- Workflow files, unsafe paths, symlinks, and submodules are never applied.
- Stale, malformed, oversized, or ambiguous artifacts fail closed.
- Secrets and write-capable credentials must not appear in logs, artifacts,
  Stage 1 inputs, or test fixtures.
- A nonzero `prek` exit is not by itself a reason to discard a stable,
  nonempty, validated artifact. It remains a hard failure when there is no
  artifact to apply.

If a requested change conflicts with one of these invariants, stop and explain
the conflict rather than implementing it.

## Actions and workflow contracts

- Keep the input and output tables in `README.md`, the Action metadata, and
  their tests synchronized.
- Keep the marked Stage 1 and Stage 2 YAML blocks in `README.md` byte-for-byte
  synchronized with the matching files in `examples/`.
- Preserve the exact workflow names used by `workflow_run` and
  `source-workflow`.
- Preserve least-privilege permissions and `persist-credentials: false`.
- The repository's self-fix workflow may check out the trusted default branch
  solely to load `./fix`, with `persist-credentials: false`.
- The privileged fix workflow must never check out pull-request code, execute
  shell commands, invoke `git`, or run hooks.

## Documentation style

Write for developers who are new to the project:

- Lead with what the user can accomplish.
- Use clear English and short, direct sentences.
- Put setup steps before implementation details.
- Define unavoidable GitHub Actions or security terminology.
- Keep low-level implementation details in the implementation plan unless they
  help users configure, operate, or recover the Action.
- Do not make claims that are broader than the tested behavior.

## Git practices

- Base feature branches on the latest `main`.
- Keep commits focused and include generated files when required.
- Do not commit secrets, local environment files, `node_modules/`, coverage
  output, or temporary files.
- Do not force-push, bypass protection, create a pull request, or publish a
  release unless the user explicitly requests it.
- Before handoff, inspect `git status`, review the complete diff, and report the
  validation performed.
