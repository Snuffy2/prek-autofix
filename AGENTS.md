# AGENTS.md

## Purpose

`prek-autofix` is a TypeScript GitHub Action that runs `prek` against pull
requests and safely applies mechanical fixes. Changes must preserve the trust
boundary between the unprivileged collection workflow and the privileged
application workflow.

## Repository layout

- `packages/collect/src/` runs hooks without write credentials and creates the
  change artifact.
- `packages/apply/src/` validates a completed collection run and applies an
  approved artifact through the GitHub API.
- `packages/shared/src/` contains the artifact format and shared validation.
- `collect/action.yml` and `apply/action.yml` define the public Action
  interfaces.
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

- Collection runs pull-request-controlled code with read-only repository
  permission and without the autofix token.
- Application never checks out pull-request code, invokes `git`, or runs hooks.
- The autofix token is used only after the workflow run, artifact, pull
  request, current head, paths, file modes, and limits have been validated.
- Branch updates remain non-force, atomic, and tied to the validated source
  commit.
- Workflow files, unsafe paths, symlinks, and submodules are never applied.
- Stale, malformed, oversized, or ambiguous artifacts fail closed.
- Secrets and write-capable credentials must not appear in logs, artifacts,
  Stage 1 inputs, or test fixtures.

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
- Pin third-party Actions to reviewed full commit SHAs with a version comment.
- Do not add checkout or shell execution to the privileged application
  workflow.
- Update `docs/implementation-plan.md` when changing the public interface,
  artifact schema, workflow protocol, or security model.

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
