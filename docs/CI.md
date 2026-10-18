# CI, budgets and dependencies

What the project's automated checks are, the limits they enforce, and how dependency updates are handled. The workflows are in `.github/workflows/`. For the release jobs, see [RELEASE.md](./RELEASE.md).

## Workflows

| Workflow | When | What it does |
| --- | --- | --- |
| `ci.yml` | pull requests, pushes to `main` and `codex/**`, tags `v*` | `build-test` always. For `v*` tags also `package`, `publish` (environment `marketplace`) and `release`. |
| `api-docs.yml` | push to `main` | Builds the TypeDoc API reference and deploys it to GitHub Pages: <https://sureforgetech.github.io/filemaker-data-api-for-vs-code/api/>. |
| `dependency-auto-merge.yml` | Dependabot pull requests | Enables auto-merge for safe dev-dependency updates (see below). |
| `entra-identity-id.yml` | manual | One-off helper for the Entra publishing setup ([job aid](./JOB_AID_ENTRA_PUBLISHING.md)). Delete it when the setup is done. |
| `secret-rotation-reminder.yml` | monthly | A scaffold that does nothing yet; see [SECRETS.md](./SECRETS.md). |

Every job's runner comes from the repository variable `LINUX_RUNNER_LABELS` (a JSON array of labels). It is currently `["ubuntu-latest"]`, a GitHub-hosted runner, which is free because this repository is public. Do not write a hosted label directly into a workflow; keep using the variable so the runner can change without editing workflows.

## Required status check

Branch protection on `main` requires one status check, **`build-test`**, and no approving review. Nothing else is required today. Code scanning default setup is not configured on this repository, so there is no required scanning check.

`build-test` runs, in order: `npm ci`, `npm audit --omit=dev --audit-level=high`, lint (`--max-warnings=0`), typecheck (`tsc --noEmit` per workspace, source and tests), `test:coverage` (Vitest, with coverage thresholds), build (esbuild bundle plus webview assets), package check (`npm run package:check`: it first verifies that `extension/THIRD_PARTY_NOTICES.txt` is current, then runs `vsce package`), and the VSIX size budget. To reproduce it locally:

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run package:check
```

If you add a check that should block merges, add its context to the branch protection rule for `main` in the same change, and update this page. A custom guardrail is worth adding when lint, the compiler and the tests cannot express the rule (for example a settings change that must come with a migration).

## Budgets

- **VSIX size:** the build fails above 5 MiB. See [BUNDLE_SIZE.md](./BUNDLE_SIZE.md) for the reasoning, how to raise the cap and how to trim the package.
- **Activation time:** a unit test fails when `activate()` takes more than 500 ms of in-process work. See [PERFORMANCE.md](./PERFORMANCE.md).

## Dependencies

Dependabot checks npm weekly (Monday 09:00 UTC) and GitHub Actions weekly. Updates are grouped (`dev-dependencies`, `production-dependencies`, `security-patches`). Some packages (`axios`, `next`, `react`, `react-dom`, `zod`) have a 30-day cooldown. `@types/vscode` is ignored on purpose: it must match `engines.vscode`, because `vsce package` fails when it is newer. `uuid` major updates are ignored until the Azure SDK chain supports them; the reasons are in `.github/dependabot.yml` next to each rule.

| Update | Handling |
| --- | --- |
| Direct development dependency, patch or minor | `dependency-auto-merge.yml` enables auto-merge. GitHub merges only after `build-test` passes. |
| Production dependency | Human review. |
| Any major version | Human review. |
| Security update | Human review, reviewed daily. |
| Anything that changes the lockfile structure, build tooling or packaging output in a non-obvious way | Human review. |

The auto-merge workflow runs for pull requests whose author is `dependabot[bot]`, that target `main` and are not drafts. It does not bypass branch protection.

Review Dependabot security alerts each business day, grouped dev updates weekly and grouped production updates monthly. When a dependency is deliberately pinned or ignored, keep the reason in `.github/dependabot.yml`.
