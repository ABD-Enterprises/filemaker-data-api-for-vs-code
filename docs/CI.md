# CI, budgets and dependencies

What the project's automated checks are, the limits they enforce, and how dependency updates are handled. The workflows are in `.github/workflows/`. For the release jobs, see [RELEASE.md](./RELEASE.md).

## Workflows

| Workflow | When | What it does |
| --- | --- | --- |
| `ci.yml` | pull requests, pushes to `main`, tags `v*` | `build-test` and `cross-platform` always. For `v*` tags also `package`, `publish` (environment `marketplace`) and `release`. |
| `api-docs.yml` | push to `main` | Builds the TypeDoc API reference and deploys it to GitHub Pages: <https://sureforgetech.github.io/filemaker-data-api-for-vs-code/api/>. |
| `dependency-auto-merge.yml` | Dependabot pull requests | Enables auto-merge for safe dev-dependency updates (see below). |
| `entra-identity-id.yml` | manual | One-off helper for the Entra publishing setup ([job aid](./JOB_AID_ENTRA_PUBLISHING.md)). Delete it when the setup is done. |
| `secret-rotation-reminder.yml` | monthly | A scaffold that does nothing yet; see [SECRETS.md](./SECRETS.md). |

Every job's runner comes from the repository variable `LINUX_RUNNER_LABELS` (a JSON array of labels), except `cross-platform`, which names its operating systems in its matrix. The variable is currently `["ubuntu-latest"]`, a GitHub-hosted runner, which is free because this repository is public. Do not write a hosted label directly into a workflow; keep using the variable so the runner can change without editing workflows. `cross-platform` is the one deliberate exception: it needs a Windows runner, GitHub-hosted runners are free for a public repository, and the self-hosted-only rule applies to private repositories. Do not copy it into a private repository.

CI concurrency groups use the workflow name and pull request number, or the run ID for other events. Only pull request runs cancel earlier runs in their group; pushes to `main` and tags do not cancel earlier runs.

The `release` job and the dependency auto-merge workflow use the composite action `.github/actions/ensure-gh`. It reuses an installed GitHub CLI or downloads version 2.102.0 for Linux amd64/arm64 and verifies its release checksum, exposing the executable at `$RUNNER_TEMP/gh-cli/bin/gh`. The auto-merge workflow checks out the trusted pull request base commit for this local action, with persisted credentials disabled.

## Required status check

Branch protection on `main` requires one status check, **`build-test`**, and no approving review. Nothing else is required today. Code scanning default setup is not configured on this repository, so there is no required scanning check.

After checkout and Node 22 setup, `build-test` runs, in order: `npm ci`, `npm audit --omit=dev --audit-level=high`, lint (`--max-warnings=0`), workflow regression tests (`node --test .github/tests/ci.test.mjs`), the mock API contract (`npm run mock:check -w extension`), typecheck (the workspace TypeScript checks, including extension source and tests), `test:coverage` (Vitest, with coverage thresholds), build (shared output, esbuild bundles and webview assets), designer and runtime workspace tests (`npm test -w designer-ui -w runtime-next`, after shared is built), package check (`npm run package:check`: it first verifies that `extension/THIRD_PARTY_NOTICES.txt` is current, then runs `vsce package`), and the VSIX size budget. To run the checks locally (the size cap is enforced in CI):

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
node --test .github/tests/ci.test.mjs
npm run mock:check -w extension
npm run typecheck
npm run test:coverage
npm run build
npm test -w designer-ui -w runtime-next
npm run package:check
```

If you add a check that should block merges, add its context to the branch protection rule for `main` in the same change, and update this page. A custom guardrail is worth adding when lint, the compiler and the tests cannot express the rule (for example a settings change that must come with a migration).

## Cross-platform job

After checkout and Node 22 setup, `cross-platform` runs on `windows-latest` and on `ubuntu-latest` (`fail-fast: false`, `permissions: contents: read`), in order: `npm ci`, `npm run build`, `npm test -w designer-ui -w runtime-next` (after shared is built), `npm run lint`, `npm run typecheck`, `npm run test:coverage` and `npm run package:check`. It does not run the dependency audit, workflow regression tests, mock API contract check or VSIX size budget (those stay in `build-test`), and it never touches the release jobs.

It is **not a required check**: branch protection still requires only `build-test`, so a failure that only happens on one operating system is visible on the pull request without blocking unrelated work. Treat a red `cross-platform` run as a real bug on that platform: fix the product code or the test, and skip a test on a platform only with a stated reason and a test that covers the same behaviour there. Do not rename `build-test`.

Windows checks out with `core.autocrlf=true` (Git for Windows default), which is deliberate: that is what Windows contributors have. `.gitattributes` sets `eol=lf`, so the working tree still comes out with LF.

What the Windows run exercises that the others cannot: a real named-pipe MCP server and clients, the real shim over that pipe, directory junctions (`fs.symlink(..., 'junction')`), read-only file replacement, access rights read with `icacls`, and PowerShell-based process start times. What it cannot show: Windows on ARM, a non-English Windows, a user who is not an administrator (the runner account is one, so a directory symbolic link can be created there), another user connecting to the pipe, and the real VS Code interface.

To reproduce on your own Windows or Linux machine, use the same commands:

```bash
npm ci
npm run build
npm test -w designer-ui -w runtime-next
npm run lint
npm run typecheck
npm run test:coverage
npm run package:check
```

On Windows, run them in PowerShell or cmd.exe with Node 22 and Git on the PATH (Git for Windows also provides the `openssl` that the mock server's TLS tests use; without it those tests skip). To run one platform-specific file: `npx vitest run test/unit/windowsFilesystem.test.ts` inside `extension/`. To watch the CI run from a terminal: `gh run watch` and, for a failure, `gh run view --log-failed`.

## Budgets

- **VSIX size:** `build-test` fails above 3 MiB (3,145,728 bytes). See [BUNDLE_SIZE.md](./BUNDLE_SIZE.md) for the reasoning, how to raise the cap and how to trim the package.
- **Activation time:** a unit test fails when `activate()` takes more than 500 ms of in-process work. See [PERFORMANCE.md](./PERFORMANCE.md).

## Dependencies

### Maintenance review, 2026-10-21

The supplied lockfile and installed packages already contain Axios 1.20.0, zod 4.6.5, typescript-eslint parser/plugin 8.72.0, esbuild 0.28.2, ESLint 10.13.0, globals 17.13.0, Prettier 3.9.10, TypeDoc 0.28.20 and nock 14.0.17. Only the extension's parser declaration needed alignment from `^8.33.1` to `^8.72.0`; no resolved package version changed. No formatter was run. Offline `npm outdated` could not find cached registry metadata, so this is a review of the supplied versions, not a claim that they are the latest releases. Offline production and full audits print zero findings because npm skips advisory retrieval in offline mode; neither result verifies a clean audit. Both audits still need a network-enabled run.

Version limits for this maintenance task (the first three major versions are already in the supplied checkout and were left unchanged):

- **TypeScript:** keep the existing 7.0.2 compiler and `typescript6` test alias; consider another major only after compiler, test and documentation-tool compatibility passes. TypeDoc 0.28.20 declares support through TypeScript 6.0.x, so its compatibility with the existing compiler still needs a separate review.
- **Vitest and coverage:** keep the existing 5.0.5 versions together; consider another major only after the test configuration, coverage provider and coverage floors pass together.
- **@vscode/vsce:** keep the existing 4.0.0; consider another major only after its Node requirements and the actual VSIX contents and size pass the release checks.
- **@types/vscode:** keep `~1.96.0` with engine `^1.96.0`; move beyond the 1.96 line only when the minimum supported editor is deliberately raised and packaging passes.
- **@types/node:** keep the 22 line; move beyond it only when the supported runtime and CI move together and extension compatibility is checked.
- **nock:** keep major 14; consider major 15 only after its changed interceptors pass the TLS, proxy and MCP tests that use real sockets.

Axios stays at the supplied 1.20.0. Its local `node_modules/axios/CHANGELOG.md` stops at 1.19.0, so it does not supply release notes for 1.20.0. Before any further Axios update, read the matching release notes and pass the custom transport, TLS, pinning and proxy tests outside the socket-restricted sandbox; keep the previous version if those behaviors change. The installed HTTP adapter still accepts `transport`, preserves an installed proxy tunnel agent and uses the supplied HTTPS agent when no tunnel agent is set. The extension uses `maxRedirects: 0`; pinning, proxy refusal and connection deadlines must keep working.

### Automated updates

Dependabot checks npm weekly (Monday 09:00 UTC) and GitHub Actions weekly. Root npm updates are grouped (`dev-dependencies`, `production-dependencies`, `security-patches`). Some packages (`axios`, `next`, `react`, `react-dom`, `zod`) have a 30-day cooldown. `@types/vscode` is ignored on purpose: it must stay compatible with the minimum `engines.vscode`, because `vsce package` fails when it is newer. Major updates to `nock` are ignored because version 15 changes interceptors and breaks the real-socket TLS and MCP tests; major updates to `@types/node` are ignored to keep types aligned with Node 22. The reasons are in `.github/dependabot.yml` next to each rule. The separate `/tools/publish` npm entry groups publish-tool updates with a seven-day cooldown. GitHub Actions minor and patch updates are grouped with a seven-day cooldown; major updates are ignored.

| Update | Handling |
| --- | --- |
| Direct development dependency, patch or minor | `dependency-auto-merge.yml` enables auto-merge. GitHub merges only after `build-test` passes. |
| Production dependency | Human review. |
| Any major version not ignored above | Human review. |
| Security update | Human review, reviewed daily. |
| Anything that changes the lockfile structure, build tooling or packaging output in a non-obvious way | Human review. |

The auto-merge workflow runs for pull requests whose author is `dependabot[bot]`, that target `main` and are not drafts. It does not bypass branch protection.

Review Dependabot security alerts each business day, grouped dev updates weekly and grouped production updates monthly. When a dependency is deliberately pinned or ignored, keep the reason in `.github/dependabot.yml`.
