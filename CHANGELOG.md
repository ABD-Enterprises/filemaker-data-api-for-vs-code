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

- Record Editor edit-conflict protection: saving sends the record's loaded `modId`, FileMaker refuses the edit if it changed (error 306), and the editor shows the fields that changed, keeps the draft, and offers a reload. Batch update is unchanged.
- Query Builder form-based find editor, actionable results (View/Edit, found-count summary, page sorting, copy as table), theme-aware styling, grouped settings with one-click migration, clearer command titles, two more walkthrough steps, and progress for code generation and environment compare (#364).

### [FIX]

- Return an empty result when a find matches nothing or the offset is past the last match (FileMaker's HTTP 404 / error 401), instead of failing. This also fixes batch export failing on its last request when the match count is an exact multiple of the page size.
- Share one session renewal between parallel requests after a session expires, instead of opening one session per request and orphaning the rest.
- Query Builder paging uses FileMaker's 1-based offsets, so the next page no longer repeats a record (#364).
- Renamed settings resolve scope by scope, so a more specific value wins whichever name it uses (#364); non-string API path settings fall back to their defaults (#365).
- Remove the never-implemented Export/Import Connection Profiles commands (#366).
- Apply enterprise, offline and performance setting changes one at a time, with failures logged.
- Remove the unused `filemaker.telemetry.enabled` setting.
- Honor picker and input cancellation, restore FM Web profile switching, and prevent stale connection-status updates while simplifying profile and layout selection.

### [INTERNAL]

- ADR-0004 (proposed): AI integration design — schema context, language-model tools, MCP server, with read-only defaults and confirmed writes.
- Release pipeline: separate publish (environment-gated, tag-on-main and version checks, no `npm ci` with the token) and release jobs; untrack the session lock file.
- Add a mock FileMaker Data API (`npm run mock:server`) and an end-to-end client check against it (`npm run mock:check`); neither is shipped in the VSIX.
- Release 1.3.0 under the SureForgeTech Marketplace publisher; the repository moved to the SureForgeTech GitHub org and in-repo links now point there.
- Workflows install with `npm ci`; coverage thresholds gate CI; the orphaned `scripts/validate.sh` is removed; the root `package.json` declares Node >=22; `.vscodeignore` keeps local coverage reports out of the VSIX (#317, #318, #309, #301).
- A test activates the extension and fails when a contributed command is not registered (#366).
- Isolate the generated-client compilation test from ambient package types and give its full TypeScript compile a dedicated 30-second timeout on shared CI runners.
- Fix all extension test-file type errors with typed fixtures and focused service contracts; include source and tests in the standard typecheck command.
- Move CI, `.nvmrc`, the devcontainer, and setup docs from Node 20 (end of life 2026-04-30) to Node 22.
- Restore a passing CI build under TypeScript 7: replace the removed `moduleResolution: node` in the extension tsconfig, point the one compiler-API test at an aliased TypeScript 6, and align `@vitest/coverage-v8` with the installed Vitest major so `test:coverage` runs.
- Route every GitHub Actions job (`ci.yml`, `api-docs.yml`, `dependency-auto-merge.yml`, `secret-rotation-reminder.yml`) to the organization's self-hosted Linux runners via `${{ fromJSON(vars.LINUX_RUNNER_LABELS) }}`; GitHub-hosted runners are no longer available to this organization.
- Harden `dependency-auto-merge.yml` (a `pull_request_target` workflow): gate the job on the pull request author (`github.event.pull_request.user.login`) instead of `github.actor`, and grant `contents: write` / `pull-requests: write` to the job only, with no workflow-level permissions.

### [SECURITY]

- Escape database-supplied names in generated types, clients and snippets; give punctuation-only-different layouts distinct file names and safe Windows names.
- Neutralize spreadsheet formulas in CSV exports.
- Validate the workspace snapshot index entries so a repository's index cannot make pruning delete other files; reject Windows drive-relative output folders.
- Redact the session token in request paths, more query parameters and JSON keys, and credentials embedded in URLs.
- Ask before running a workspace plugin, once per folder content (workspace + SHA-256 of every file), instead of running every file in `.vscode/filemaker-plugins` when the folder is trusted.
- Make offline mode and `features.*.enabled` restrict-only for workspace settings, and gate the FM Web preview bridge (writes, script runs) on offline mode, feature switches and enterprise policy.
- Make enterprise policy restrict-only: workspace settings and `.vscode/filemaker.config.json` may turn enterprise mode on or lower the role, never turn it off or raise the role above the user's own.
- Layout Mode `runScript` behaviours get the Script Runner's checks plus an explicit confirmation naming the script, parameter and connection.
- FM Web Preview confirms before running `npm install` / `npm run dev` in the generated runtime folder.
- Ignore `.filemaker/profile-template.json` in an untrusted workspace, never lock the server address from it, name the address on the wizard banner, and confirm before saving or testing credentials against a template-supplied address.
- Connection wizard: no credential reuse after the server, proxy or user changes; Test Connection uses throwaway credentials and full address validation; confirm before sending credentials over remote `http://`; reject URLs with embedded credentials; validate proxy endpoint and form data.
- Generate webview CSP nonces with `crypto.randomInt` instead of `Math.random()` (#292).
- Harden the GitHub Actions workflows flagged by zizmor: `api-docs.yml` grants `pages: write` and `id-token: write` only to the deploy job; every `actions/checkout` sets `persist-credentials: false`; the CI `setup-node` steps set `package-manager-cache: false` so a future action bump cannot start restoring a package-manager cache in the job that publishes the extension.
