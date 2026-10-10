# Changelog

This file is the operator-facing release ledger. Every pull request adds one
line under `## Unreleased` with one of the allowed section labels, or
applies the `changelog-skip` label for a purely no-impact change. See EAS
§B2 Universal PR Essentials.

Allowed entry labels:

- `[BREAKING]` - incompatible API, data, deployment, or operator change.
- `[FEATURE]` - new user-visible or operator-visible capability.
- `[FIX]` - bug fix or compatibility repair.
- `[INTERNAL]` - tests, CI, docs, refactors, generated artifacts, or process.
- `[SECURITY]` - vulnerability fix, security control, or hardening change.

PR title prefix matches the highest-tier label added:
`[BREAKING]` -> `[major]`, `[FEATURE]` -> `[minor]`, others -> `[patch]`.

## Unreleased

### [BREAKING]

- None.

### [FEATURE]

- None.

### [FIX]

- None.

### [INTERNAL]

- Move CI, `.nvmrc`, the devcontainer, and setup docs from Node 20 (end of life 2026-04-30) to Node 22.
- Restore a passing CI build under TypeScript 7: replace the removed `moduleResolution: node` in the extension tsconfig, point the one compiler-API test at an aliased TypeScript 6, and align `@vitest/coverage-v8` with the installed Vitest major so `test:coverage` runs.

### [SECURITY]

- Harden the GitHub Actions workflows flagged by zizmor: `api-docs.yml` grants `pages: write` and `id-token: write` only to the deploy job; every `actions/checkout` sets `persist-credentials: false`; the CI `setup-node` steps set `package-manager-cache: false` so a future action bump cannot start restoring a package-manager cache in the job that publishes the extension.
