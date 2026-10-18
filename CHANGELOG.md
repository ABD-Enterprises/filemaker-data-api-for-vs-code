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

- Add user-scope `filemaker.export.neutralizeFormulas` to opt out of CSV/Copy-as-table formula apostrophes (workspace cannot turn it off).
- Connection wizard: custom CA certificate file (validated PEM) and per-profile, confirmed 'allow self-signed (insecure)' option; neither can come from a workspace template; flagged in the profile list and picker; editing keeps `aiAccess`.
- AI tools for MCP clients (ADR-0004 phase 3): `AiMcpServer` over a local socket with per-session token, discovery file with pid and start time, the bundled `aiMcpShim.js` stdio program, `list_changed` on policy changes, commands to start/stop the server and copy the client config; off by default (`filemaker.ai.externalServer.enabled`, user scope), no local policy of its own.
- AI tools for VS Code language-model clients (ADR-0004 phase 2): `AiToolService` tool core (policy, layout consent, record and write caps, hidden-field filter, host-built write dialogs with fresh modId, delete by typed id, script allowlist, redaction, audit log), registered as language-model tools only when the user-scope switches allow; profile `aiAccess`, `ai` enterprise feature id, kill-switch status bar item, **Set AI Access for Connection** and **Show AI Activity** commands.
- **FileMaker: Write AI Context** (ADR-0004 phase 1): writes a size-limited, allowlist-rendered Markdown summary of selected layouts, fields and script names for AI tools, outside the repository by default, with a user-scope-only `filemaker.ai.contextPath`, confined paths and marker-section updates.
- Record Editor edit-conflict protection: saving sends the record's loaded `modId`, FileMaker refuses the edit if it changed (error 306), and the editor shows the fields that changed, keeps the draft, and offers a reload. Batch update is unchanged.
- Query Builder form-based find editor, actionable results (View/Edit, found-count summary, page sorting, copy as table), theme-aware styling, grouped settings with one-click migration, clearer command titles, two more walkthrough steps, and progress for code generation and environment compare (#364).

### [FIX]

- Map Node/OpenSSL error codes to actionable messages via one shared mapping (normalizeError); Retry only where it helps; no Edit Profile for 403/privilege; shared FileMaker error-code table with advice; Retry-After; HTML details truncated.
- Wizard: http+self-signed message, custom CA extends system roots, TLS agent keyed by file stamp, database/API path change resets aiAccess; kill-switch message names the true cause.
- FM Web preview: clear 'unavailable in this installation' error instead of the old fallback app; version-marked managed runtime files refreshed in already generated apps; env file written without following symlinks.
- Implement Create Record in the Record Editor (field list, validation, confirmation, new record ID) with unit tests and an end-to-end test against the mock FileMaker server.
- Describe the workspace-state secret fallback as obfuscation, not encryption, in the warning toast, setting text and code comments.
- Fix 404 homepage/author URL; declare virtualWorkspaces unsupported; mention AI tools in the untrusted-workspace description; add enumDescriptions to seven enum settings; add the Claris trademark statement to the README.
- Allow `..` inside snapshot/offline-cache index file names (layout `Q1..Q2`) while still rejecting traversal; traversal corpus added.
- AI kill-switch status item does nothing (with guidance) when AI is not enabled, instead of silently setting the switch.
- Toggle Offline Mode writes the user (Global) scope, creates no workspace settings file, and reports the effective state and what keeps it on; a workspace `offline.mode: true` can no longer be cleared by the command (edit the workspace file).
- Batch CSV import ignores the `recordId`/`modId` meta columns so an exported file re-imports cleanly; round-trip test added.
- FM Web preview: write the bridge URL and session token to the generated runtime's gitignored `.env.local`, send `X-FM-Bridge-Token` from the runtime client (and call `fetch` unbound), and apply `features.recordEdit.enabled` and the enterprise `recordEdit` guard to bridge edit/create/delete.
- AI tools follow-ups (#380): 4,000-character dialog budget, placeholder markers refused in writes, host-only server scrub, session generation counter for the quota, wider post-dialog re-check.
- Return an empty result when a find matches nothing or the offset is past the last match (FileMaker's HTTP 404 / error 401), instead of failing. This also fixes batch export failing on its last request when the match count is an exact multiple of the page size.
- Share one session renewal between parallel requests after a session expires, instead of opening one session per request and orphaning the rest.
- Query Builder paging uses FileMaker's 1-based offsets, so the next page no longer repeats a record (#364).
- Renamed settings resolve scope by scope, so a more specific value wins whichever name it uses (#364); non-string API path settings fall back to their defaults (#365).
- Remove the never-implemented Export/Import Connection Profiles commands (#366).
- Apply enterprise, offline and performance setting changes one at a time, with failures logged.
- Remove the unused `filemaker.telemetry.enabled` setting.
- Honor picker and input cancellation, restore FM Web profile switching, and prevent stale connection-status updates while simplifying profile and layout selection.

### [INTERNAL]

- Attach source maps to releases; docs describe external maps and obfuscation; clearer designer-ui build message; constant-time bridge token compare.
- Untrack artifacts/*.log and gitignore them.
- Ship generated `THIRD_PARTY_NOTICES.txt` (checked in CI via `package:check` and a unit test); exclude lint config, build scripts, QA docs and ARCHITECTURE.md from the VSIX.
- Production-minify the extension, worker and Layout Mode UI bundles; no inline or shipped source maps; clear designer-ui build failure message.
- Publish with Microsoft Entra ID (OIDC, managed identity) instead of `VSCE_PAT`; add the setup job aid and a one-off helper workflow.
- Job aid for the Marketplace publishing token, with the 2026-12-01 PAT retirement noted.
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

- Delete Record requires the recordEdit setting and the enterprise recordEdit guard, like the bridge and AI tools.
- Make `filemaker.secrets.fallback` application-scoped and `filemaker.typegen.outputDir` restricted in untrusted workspaces.
- Query Builder copy-as-table neutralizes formula-looking cells like the CSV export (shared behaviour, parity-tested).
- Record edit, create and upload and the Script Runner require a trusted workspace (commands, panels and panel messages), matching the documented behaviour; the manifest's untrusted-workspace description lists them.
- Escape database-supplied names in generated types, clients and snippets; give punctuation-only-different layouts distinct file names and safe Windows names.
- Neutralize spreadsheet formulas in CSV exports: a cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe.
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
