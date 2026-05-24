# CI Baseline

This document records what the project's CI considers a green build, why
the previous custom runtime guardrail validator was retired, and the criteria
for re-introducing a custom guardrail.

## Required status checks (branch protection)

Branch protection on `main` enforces two contexts:

| Context      | Source                     | What it covers                                                                                                           |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `build-test` | `.github/workflows/ci.yml` | `npm install`, `npm audit --omit=dev --audit-level=high`, `lint`, `typecheck`, `test:coverage`, `build`, `package:check` |
| `CodeQL`     | GitHub default setup       | Code scanning for `actions`, `javascript`, `javascript-typescript`, `typescript`                                         |

Together these are the minimum bar a change must clear before it can land
on `main`.

Release-tag builds also publish the headless FileMaker bridge image to GHCR
after the Docker image smoke test passes.

## What `build-test` actually runs

The `build-test` job in `ci.yml` is the unit of CI gating. Locally,
`npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run build`,
and `npm run package:check` reproduce it.

- **Lint** — eslint against `extension/src/**/*.ts` and `extension/test/**/*.ts`
  with `--max-warnings=0`
- **Typecheck** — `tsc --noEmit` per workspace via `npm run typecheck --workspaces --if-present`
- **Tests** — `vitest run --coverage` in each workspace that ships a test script
- **Build** — `esbuild` bundle of the extension entry point + webview asset copy
- **Package check** — `vsce package` to ensure the extension is publishable

## Headless bridge image

The `headless-bridge-image` job builds the standalone bridge Docker image and
smoke-tests its `/healthz` endpoint. On release tags, `publish-headless-bridge-image`
pushes the same image to `ghcr.io/abd-enterprises/filemaker-bridge`.

## What was removed and why

Commit `3bed46c` ("Remove tracked AI workflow state (#27)") deleted the
old custom runtime guardrail validator and its workflow. That validator
coupled CI gating to a locally tracked task-state convention that is no
longer how the project tracks work.

Tracking now lives on the GitHub project board per the Enterprise AI
Standards adoption (`.ai/config.json`); the validator's preconditions
are obsolete. Branch protection was updated alongside the deletion to
require only `build-test` + `CodeQL`.

## Re-introduction criteria

A custom guardrail (validator + workflow + required check) should be
reintroduced if any of the following becomes true:

1. We need to enforce **policy that lint/tsc/CodeQL cannot express** —
   e.g. a domain-specific invariant (a profile schema migration that must
   accompany a settings change, an exhaustiveness check across two
   workspaces).
2. We adopt a **package manager** other than `npm install`, in which case
   a check that the manifest's `packageManager` field matches what's
   actually used would be cheap insurance.
3. We start failing on **dependency audit thresholds higher than `high`**
   (e.g. enforce `--audit-level=moderate`); today the audit step in
   `build-test` already covers `high`+.
4. The Enterprise AI Standards CLI publishes a **shared validator**
   that's worth wiring in; mirror its required checks via branch
   protection rather than duplicating the validator.

If any of those triggers fire, add a new workflow under
`.github/workflows/`, add the new context to required checks, and update
this document with the rationale.

Until then, the baseline is intentional: the smaller the surface CI
gates, the easier it is to keep CI green and fast.
