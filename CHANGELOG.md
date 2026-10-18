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

- A malformed `filemaker.ai.hiddenFields` value no longer switches hiding off for the whole scope: non-text entries are ignored and the valid names in the same list still hide (a bare string counts as one name), and the Output panel says so once.
- Refreshing a generated FM Web runtime file now keeps the file permissions of the file it replaces, and a write that fails part way (for example a full disk) no longer leaves a hidden `.tmp` file in the generated folder.

### [INTERNAL]

- None.

### [SECURITY]

- None.

## 1.4.0 - 2026-10-18

Minor release: no data migration, and no command or setting was removed. User-facing notes: `extension/CHANGELOG.md` and `extension/UPGRADE.md`. Entries for 1.2.0 and 1.3.0 were removed from this ledger. The user-facing ones are in `extension/CHANGELOG.md` under those versions; the CI and tooling ones that are not there (zizmor workflow hardening, the TypeScript 7 build restore, the Node 22 move, runner routing, the `dependency-auto-merge.yml` `pull_request_target` hardening, the npm ci and coverage-threshold changes) are in git history (commits up to 89c5109) only.

### [BREAKING]

- None.

### [FEATURE]

- Add `FileMaker: About / Show Version` and show the extension version in the status bar tooltip, Explorer title, webview footers, Output channel and diagnostics report; bug report template asks for the copied block.
- Add `FileMaker: Show Effective Settings` and a once-per-setting notice when a workspace value is ignored; label every setting `User settings only.`, `Workspace can only make this stricter.` or `Per workspace.`; explain savedQueries.scope, snapshots storage and typegen output dir; docs section on User vs Workspace settings. Notices use fixed text only; Restricted Mode and multi-root are explained. Explanation only: no enforcement change.
- Test Connection ladder (productInfo, databases, sign-in) naming the failed step; status bar shows real session health.
- Pin one server certificate by SHA-256 (trust dialog from Test Connection/Connect/errors), refuse changed or expired pinned certificates, no checks disabled except the legacy flag, legacy profiles warned and convertible; system certificates included when Node can read them.
- Add user-scope `filemaker.export.neutralizeFormulas` to opt out of CSV/Copy-as-table formula apostrophes (workspace cannot turn it off).
- Connection wizard: custom CA certificate file (validated PEM), per profile, never from a workspace template; editing keeps `aiAccess`. (The development-time 'allow self-signed' checkbox was replaced by certificate pinning before release.)
- AI tools for MCP clients (ADR-0004 phase 3): `AiMcpServer` over a local socket with per-session token, discovery file with pid and start time, the bundled `aiMcpShim.js` stdio program, `list_changed` on policy changes, commands to start/stop the server and copy the client config; off by default (`filemaker.ai.externalServer.enabled`, user scope), no local policy of its own.
- AI tools for VS Code language-model clients (ADR-0004 phase 2): `AiToolService` tool core (policy, layout consent, record and write caps, hidden-field filter, host-built write dialogs with fresh modId, delete by typed id, script allowlist, redaction, audit log), registered as language-model tools only when the user-scope switches allow; profile `aiAccess`, `ai` enterprise feature id, kill-switch status bar item, **Set AI Access for Connection** and **Show AI Activity** commands.
- **FileMaker: Write AI Context** (ADR-0004 phase 1): writes a size-limited, allowlist-rendered Markdown summary of selected layouts, fields and script names for AI tools, outside the repository by default, with a user-scope-only `filemaker.ai.contextPath`, confined paths and marker-section updates.
- Record Editor edit-conflict protection: saving sends the record's loaded `modId`, FileMaker refuses the edit if it changed (error 306), and the editor shows the fields that changed, keeps the draft, and offers a reload. Batch update is unchanged.

### [FIX]

- Restored webview tabs show a reopen page instead of staying dead: a serializer for every panel type, and `onWebviewPanel` activation events for each so the serializer exists before a saved tab is restored.
- Script Runner and Layout Mode show non-zero script errors as failures with code and meaning; timeout says the script may still run.
- Command Palette context keys refresh when profiles change and after Initialize FM Web.
- Follow-up review fixes: Effective Settings note, agent shutdown/grace/LRU, atomic managed-file writes, 956/1703 wording, CA-file hint only for known host names.
- Script errors on container upload and find are shown; Effective Settings notes and workspace-file watching; TLS agents are closed when replaced.
- Managed runtime file refresh refuses symlinks and keeps user-edited files with an older marker.
- FM Web preview commands that need the runtime template are hidden when it is not installed.
- Certificate messages and the trust dialog offer a CA file only for certificates that list host names; the pinned-through-proxy message says to use NO_PROXY.
- Pinned agent: maxCachedSessions 0 and refuse resumed sessions; proxy detection replicates proxy-from-env + axios shouldBypassProxy (corpus-tested); review notes direct dial; Claris detection capped at 1.5 s.
- Conditional/neutral certificate wording, no-host-names message, trust offer only where trustable, safe dialog text, IPv6, template confirmation on review, latch details (214 wording, proactive renewal, 1703, test-profile cleanup).
- Linear-time tag stripping on a 4 KB cut of server bodies; health: gateway 5xx/404 => unreachable, cancelled => unchanged.
- Batch stops only on account-wide errors (9/205/207/credentials); 200 fails the record only.
- System roots = Node default (incl. NODE_EXTRA_CA_CERTS) + system store; warmed in the background, 10 min TTL.
- Wizard shows a test failure once with the trust button; plain-words message for FileMaker Server's default certificate; pinning tested with that certificate shape.
- Claris ID / FileMaker Cloud hint on rejected sign-in; user guide 404 and setting-name fixes.
- Proxy error envelope with fmCode/status (documented), HTML replies reported, no redirects.
- Invalidate the schema cache on new sign-in/sign-out/profile save.
- Batch: retry only transient failures (honour Retry-After), no breaker trips on business errors, stop on privilege/credential errors with a reason; truncated only when more rows exist.
- Connect retries only transient failures (decided once where the error is built); no retry of 500/802 or certificate errors.
- Validate the Data API envelope in one place (HTML/empty/array/truncated/redirect), maxRedirects 0 with a clear redirect message, messages[0].code on 2xx, scriptError reported with writes, no-records by code (404 or 500), bare 404 no longer cached as unsupported.
- Map Node/OpenSSL error codes to actionable messages via one shared mapping (normalizeError); Retry only where it helps; no Edit Profile for 403/privilege; shared FileMaker error-code table with advice; Retry-After; HTML details truncated.
- Release workflow: the release job now downloads the source-map artifact (it previously failed after publish); packaging fails if no maps are produced.
- Wizard: custom CA extends system roots, TLS agent keyed by file stamp, database/API path change resets aiAccess; kill-switch message names the true cause.
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

### [INTERNAL]

- Release 1.4.0: version bump, changelog rolled, the release job writes notes to a file and fails if they are empty, and `docs/JOB_AID_MANUAL_RELEASE.md` for a hand-published release.
- Docs: remove the known-issue notes fixed by #390 and describe its behavior (hidden preview commands, preview-file refresh, script-error warnings for find and upload).
- Tests for review-flagged gaps (About flag, build identity guard, footer CSS, trust listener, redirects, resume backstop, template hash guard).
- Docs: reconcile the user guide, upgrade notes, smoke test and failure-mode catalogue with certificate pinning, the settings view and About / Show Version.
- Note: the self-signed checkbox was never released; legacy field is still read.
- Documentation pass: rewritten user guide, READMEs and release docs (with a non-code release checklist, upgrade notes for 1.4 and a manual-publish fallback), one security policy, a short release smoke test, and removal of stale docs.
- Complete mock FileMaker Data API (documented endpoints, error codes, mixed-quality dataset, failure faults, TLS modes) and real-VS-Code UI end-to-end tests (`extension/e2e-ui`, run with `npm run test:e2e-ui -w extension`); not part of the default test or CI path.
- Attach source maps to releases; docs describe external maps and obfuscation; clearer designer-ui build message; constant-time bridge token compare.
- Untrack artifacts/*.log and gitignore them.
- Ship generated `THIRD_PARTY_NOTICES.txt` (checked in CI via `package:check` and a unit test); exclude lint config, build scripts, QA docs and ARCHITECTURE.md from the VSIX.
- Production-minify the extension, worker and Layout Mode UI bundles; no inline or shipped source maps; clear designer-ui build failure message.
- Add a catalogue of FileMaker failure modes (`docs/FILEMAKER_FAILURE_MODES.md`): TLS and network, authentication, privilege-set effects and server quirks, what the extension shows for each, a ranked gap list, mock-server scenarios to add, and a troubleshooting-by-symptom section for the user guide. Documentation only.
- Publish with Microsoft Entra ID (OIDC, managed identity) instead of `VSCE_PAT`; add the setup job aid and a one-off helper workflow.
- ADR-0004 (proposed): AI integration design — schema context, language-model tools, MCP server, with read-only defaults and confirmed writes.
- Release pipeline: separate publish (environment-gated, tag-on-main and version checks, no `npm ci` with the token) and release jobs; untrack the session lock file.
- Add a mock FileMaker Data API (`npm run mock:server`) and an end-to-end client check against it (`npm run mock:check`); neither is shipped in the VSIX.

### [SECURITY]

- Write AI Context leaves out fields hidden by filemaker.ai.hiddenFields and says how many.
- Pinned certificates fail closed behind an HTTP proxy (refused with a clear message; agent no longer advertises rejectUnauthorized:false); CA-file/default/legacy behaviour through a proxy tested.
- Per-profile pause on automatic sign-ins after credential rejection (210-214), cleared by credential change or explicit Connect/Test; backoff for 956; parallel requests share one login.
- Delete Record requires the recordEdit setting and the enterprise recordEdit guard, like the bridge and AI tools.
- Make `filemaker.secrets.fallback` application-scoped and `filemaker.typegen.outputDir` restricted in untrusted workspaces.
- Query Builder copy-as-table neutralizes formula-looking cells like the CSV export (shared behaviour, parity-tested).
- Record edit, create and upload and the Script Runner require a trusted workspace (commands, panels and panel messages), matching the documented behaviour; the manifest's untrusted-workspace description lists them.
- Escape database-supplied names in generated types, clients and snippets; give punctuation-only-different layouts distinct file names and safe Windows names.
- Neutralize spreadsheet formulas in CSV exports: a cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe.
- Validate the workspace snapshot index entries so a repository's index cannot make pruning delete other files; reject Windows drive-relative output folders.
- Redact the session token in request paths, more query parameters and JSON keys, and credentials embedded in URLs.
- Ask before running a workspace plugin, once per folder content (workspace + SHA-256 of every file), instead of running every file in `.vscode/filemaker-plugins` when the folder is trusted.
- Make offline mode and `features.*.enabled` restrict-only for workspace settings, and gate the FM Web preview bridge (writes on offline mode, the record-edit switch and the `writeOperations` and `recordEdit` role checks; script runs on offline mode, the script runner switch and the `scriptRunner` role check).
- Make enterprise policy restrict-only: workspace settings and `.vscode/filemaker.config.json` may turn enterprise mode on or lower the role, never turn it off or raise the role above the user's own.
- Layout Mode `runScript` behaviours get the Script Runner's checks plus an explicit confirmation naming the script, parameter and connection.
- FM Web Preview confirms before running `npm install` / `npm run dev` in the generated runtime folder.
- Ignore `.filemaker/profile-template.json` in an untrusted workspace, never lock the server address from it, name the address on the wizard banner, and confirm before saving or testing credentials against a template-supplied address.
- Connection wizard: no credential reuse after the server, proxy or user changes; Test Connection uses throwaway credentials and full address validation; confirm before sending credentials over remote `http://`; reject URLs with embedded credentials; validate proxy endpoint and form data.
