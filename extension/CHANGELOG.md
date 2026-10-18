# Changelog

## Unreleased

- [FEATURE] MCP clients such as Claude Code and Cursor can use the AI tools (ADR-0004, phase 3). Off by default: turn on `filemaker.ai.externalServer.enabled` in your user settings, run **FileMaker: Start/Stop AI Server for External Tools**, then **FileMaker: Copy MCP Config for Claude Code / Cursor** and paste the result into the client. The setting is only a permission: the server runs in a window only after you run the command there and confirm its dialog (VS Code remembers that per workspace and starts it again when you reopen it, until you stop it with the same command; turning the setting off stops it everywhere and ends the automatic start for every workspace, also closed ones). A bundled stdio program (needs Node.js 18 or newer on the client's PATH) connects to a local socket (a folder only you can use; on Windows an unguessable named pipe) and proves it holds a per-session token kept in a file only you can read; it checks that the window that wrote the file is still the same process before sending the token. The tools, limits, layout approvals, write dialogs and kill switch are exactly the ones used for VS Code's own agent mode, and the tool list updates when you switch AI off. The name an MCP client gives itself is shown only in **Show AI Activity**. You get a notification when a program connects. Not supported in remote windows. What the tools return goes to the model provider behind your MCP client.
- [SECURITY] AI tools follow-ups: the approval dialog text may not pass 4,000 characters (escaped characters count, a longer write is refused) and written values are limited to 200 characters; writes also refuse the `[server]`, `[container or server URL omitted]` and `[container field omitted]` placeholders; the server-address scrub matches host-shaped text only, so a user name such as "admin" is left alone in ordinary words; a session reset while a call is in flight can no longer leave the record quota negative; and the policy re-check after a dialog also covers the script allowlist, approved layouts and the target profile.
- [FEATURE] AI tools for VS Code language-model clients such as Copilot agent mode (ADR-0004, phase 2). Off by default: set `filemaker.ai.enabled` in your user settings, pick a connection with **FileMaker: Set AI Access for Connection** (profiles gain `aiAccess`: none, read or write; default none), and tools can list layouts and scripts, describe a layout, find and read records (closed query form, 50 records per call, 500 per session, 30 calls a minute) and explain error codes. Each layout asks for approval once per session. `filemaker.ai.allowWrites` adds create, edit and delete of one record at a time, and `filemaker.ai.allowScripts` adds running scripts from `filemaker.ai.scriptAllowlist`; every write asks in a dialog that cannot be set to always allow, built by the extension from a fresh read of the record (delete needs the record id typed; an edit sent with the modId read at that time is refused if the record changed). A write is limited to 10 fields and 200 characters per value so the dialog shows all of it, and is refused if it cannot. Write attempts are capped at 10 a session and 3 a minute; the kill switch asks before switching back on and only **Start New AI Session** resets the caps. These settings are read from your user settings only; a workspace or dev container cannot turn them on. `filemaker.ai.hiddenFields` hides fields by name (best effort), `filemaker.features.ai.enabled` and an `ai` entry in `disabledFeatures` can switch AI off, offline mode blocks AI reads too, and tools are not registered in an untrusted workspace. A status bar item shows the state and is a kill switch; **FileMaker: Show AI Activity** shows a log kept outside the workspace. Anything a tool returns goes to your AI model provider; use a FileMaker account with a restricted privilege set. See the README section "AI tools".
- [INTERNAL] The release pipeline now publishes to the Marketplace with Microsoft Entra ID (a short-lived GitHub OIDC sign-in as a managed identity, `vsce publish --azure-credential`) instead of a personal access token, which Microsoft retires on 2026-12-01. One-time setup is in `docs/JOB_AID_ENTRA_PUBLISHING.md`; until it is done, upload the `.vsix` by hand.
- [INTERNAL] Add a step-by-step job aid for giving the release pipeline a Marketplace token (`docs/JOB_AID_MARKETPLACE_TOKEN.md`), including Microsoft's 1 December 2026 retirement of the token type `vsce` uses today.
- [FEATURE] **FileMaker: Write AI Context** writes a Markdown summary of the layouts you pick (up to 50), their fields and the script names, for AI coding tools to load. Names are written as JSON strings in code blocks, limited to 64 characters of letters, digits, space and `_ - . : ( )` (anything else becomes a placeholder, counted in the header); value-list values, descriptions, the server address, user name and credentials are never included, and the file stays within 20 KB. It is written outside your repository by default (the extension's storage folder) with an offer to copy it into the workspace and to add it to `.gitignore`. `filemaker.ai.contextPath` (user settings only) can point it elsewhere inside the workspace; an existing file only has its marker-delimited section replaced, and symbolic links and paths that leave the workspace are refused. Names of this kind can still carry misleading text that an AI tool might follow; treat the file as data (ADR-0004, phase 1).
- [INTERNAL] Propose how AI models in VS Code can use the Data API safely (ADR-0004): a generated schema-context file, language-model tools and an MCP server, read-only by default, with user confirmation for every write. Design only; nothing is built yet.
- [SECURITY] Names that come from a FileMaker database (layout, field and profile names) can no longer put code into generated files. Generated TypeScript types, clients and snippets now escape them for the comment, string or snippet placeholder they land in, so a layout named with `*/` and a line break stays text. Layouts whose names differ in any way that the file name drops or folds (`A/B` and `A:B`, `My Layout` and `My_Layout`, very long names) now get separate files instead of overwriting each other, and names such as `CON` or `..` get safe file names. Generated files for layouts with spaces or punctuation in the name are written under a new name (with a short hash); delete the old ones. Names that differ only in letter case can still collide on case-insensitive file systems.
- [SECURITY] CSV and batch exports no longer let a cell run as a spreadsheet formula: text starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe (plain numbers, signed numbers and phone numbers such as `+1 (555) 123-4567` are left alone). Batch update reads the apostrophe back off, so exporting and re-importing a file does not change values. `neutralizeFormulas: false` turns it off in code.
- [SECURITY] The schema snapshot index in `.vscode/filemaker/snapshots` and the offline cache index are checked before use: entries that are not well formed, or whose file name is not a plain `.json` name in that folder, are ignored, so a cloned repository's index can no longer make pruning delete other files. The generated-output folder setting also rejects Windows drive-relative paths such as `D:folder`.
- [SECURITY] Logs, history, metrics and error messages now hide more secrets: the session token in `DELETE /sessions/<token>` (it was recorded in clear in request traces), query parameters such as `access_token`, `sessionToken` and `sig`, JSON fields whose name merely contains `token`, `secret`, `password`, `session` or `apiKey` (for example `sessionToken` or `clientSecret`), and a user name and password written inside a URL.
- [INTERNAL] Release pipeline hardening: Marketplace publishing is a separate job that waits for a `marketplace` environment, runs only for a tag on `main` that matches the extension version, and no longer runs `npm ci` while holding `VSCE_PAT` (vsce is installed from its own small lockfile in `tools/publish`, without install scripts). The GitHub release step, which needs write access, is its own job. A stray Claude Code session lock file is no longer tracked.
- [SECURITY] Workspace plugins (`.vscode/filemaker-plugins/`) no longer run just because the folder is trusted: the extension hashes the whole plugin folder (every file under it, not only the entry scripts) and asks once, naming the files and workspace, before importing anything. The approval is remembered by workspace and content, so a changed, added or removed file asks again. A folder with more than 500 files, or one that contains a symbolic link, is refused, with a message saying why.
- [SECURITY] A repository can no longer weaken the enterprise policy. `filemaker.enterprise.mode`, `filemaker.enterprise.role` and `.vscode/filemaker.config.json` can turn enterprise mode on and lower the role for that workspace, but cannot switch it off or raise the role above the one in your own user settings (or the default, `developer`). Before, a repo could unlock plugin loading by setting `enterpriseMode: false` or `role: "admin"`. If you relied on a repo file to grant `admin`, set it in your user settings instead.
- [SECURITY] A repository can no longer loosen your offline mode or feature switches. A workspace `.vscode/settings.json` can switch `filemaker.offline.mode` on or a `filemaker.features.*.enabled` switch off, but cannot undo what is set in your user settings (`filemaker.offline.mode` is now also a restricted setting in untrusted workspaces).
- [SECURITY] The FM Web preview bridge applies the same limits as your own commands: writes and script runs are refused in offline mode, when the script runner is off, or when enterprise policy disallows them. The bridge also serves only the active connection and rejects a request that names another profile. Layout Mode prompt text from a layout file is flattened to one line so it cannot fake extra lines in the confirmation.
- [SECURITY] Layout Mode `runScript` behaviours (from a layout file that can come with a repository) now need a trusted workspace, the script runner to be enabled, offline mode off, and the enterprise policy to allow scripts, and they ask before running, naming the script, parameter and connection, and saying when the project file chose that connection.
- [SECURITY] **Start FM Web Preview** now shows what it will run (`npm install` and `npm run dev` in the generated runtime folder, using that folder's `package.json`) and asks first.
- [SECURITY] A `.filemaker/profile-template.json` that arrives with a cloned repository can no longer steer your credentials. It is ignored in an untrusted workspace, it no longer locks the server address, the wizard names the address it points at, and the wizard asks before saving or testing against an address that came from the workspace (unless you already have a profile for that server).
- [SECURITY] Connection wizard: editing a profile's server address, proxy address or user name no longer reuses the saved password, API key or session token for the new target; you are asked to enter the password again. **Test Connection** now uses throwaway credentials, so it never reads, overwrites or clears a real profile's secrets, and it checks the address the same way Save does. In proxy mode the backend `serverUrl` is checked and bound to the saved API key as well as the proxy address. A saved profile with a user name or password in its address stays listed so it can be fixed. The wizard also warns before sending a password to a remote `http://` address, rejects a server address with a username or password in it, validates the proxy endpoint, and checks the shape of the form data it receives.
- [INTERNAL] Add a mock FileMaker Data API for local testing (`npm run mock:server`) and an end-to-end check that runs the real client against it (`npm run mock:check`, 25 checks). It mirrors the documented response shapes and error codes, so it can catch bugs that in-memory fakes cannot; it is not shipped in the extension.
- [FEATURE] The Record Editor now refuses to overwrite a record that someone else changed after you opened it. Saving sends the version of the record you loaded, and FileMaker rejects the edit if it no longer matches (error 306). The editor then shows which fields changed since, which of them you also edited, keeps your edits in the form, and offers **Reload record**. Before, the last save silently overwrote the other person's change. Batch update is unchanged.
- [FIX] A find that matches nothing, or an offset past the last match, now returns an empty result. FileMaker reports that case as HTTP 404 with error 401, and the extension treated it as a failure, so an empty Query Builder result showed an error and a batch export failed on its final request whenever the match count was an exact multiple of the page size, or when nothing matched.
- [FIX] When a session expires, parallel requests now share one renewal instead of each opening its own FileMaker session. Before, five simultaneous requests opened five sessions and left four orphaned on the server until they timed out.
## 1.3.0

- [SECURITY] Webview Content Security Policy nonces now come from the OS random number generator (`crypto.randomInt`) instead of `Math.random()`.
- [FIX] Changes to the enterprise, offline and performance settings are applied one at a time, so overlapping changes can no longer interleave role contexts and plugin reloads, and a failure is logged instead of left unhandled.
- [FIX] Remove the unused `filemaker.telemetry.enabled` setting. The extension collects no telemetry, and the setting did nothing.
- [INTERNAL] Published under the **SureForgeTech** Marketplace publisher (`SureForgeTech.filemaker-data-api-tools`); the source moved to github.com/SureForgeTech/filemaker-data-api-for-vs-code.

## 1.2.0

_First published to the VS Code Marketplace on 2026-10-17 by manual upload under the SureForgeTech publisher, built from main at 0895ca4. This version was never tagged in git._

- [FIX] Remove the **Export Connection Profiles** and **Import Connection Profiles** commands. They were listed in power-user mode but never implemented, so running them failed with "command not found". A test now activates the extension and fails if a contributed command is not registered.
- [FIX] A hand-edited `filemaker.defaultApiBasePath` or `filemaker.defaultApiVersionPath` (or its deprecated `filemakerDataApiTools.*` name) that is not a string, such as `2` or `null`, now falls back to the default (`/fmi/data`, `vLatest`) instead of throwing.
- [FIX] Settings renamed from `filemakerDataApiTools.*` to `filemaker.*` now resolve scope by scope, so a workspace or folder value wins over a user value whichever name it uses, and within one scope the new name wins. Before, any new-name value anywhere hid every old-name value, even a more specific one.
- [FEATURE] Query Builder: build finds with a form (field, condition, value, OR requests, omit, sort) alongside the JSON editor; open any result row in the Record Viewer or Editor; see "Showing 1–100 of N found"; sort the current page by column; copy results as a table; follow the VS Code theme; and run with Ctrl/Cmd+Enter. Paging now uses FileMaker's 1-based offsets, so the next page no longer repeats a record. "begins with" and "equals (whole field)" match from the start of the field, "contains phrase" finds the literal phrase, and symbols such as @ are matched literally. Commands use a FileMaker category with clearer titles, tree rows show at most two inline actions, settings are grouped into sections with one-click migration of deprecated keys, code generation and environment compare show progress, and the walkthrough adds layout inspection and code generation steps.
- [INTERNAL] Keep the generated-client compilation test independent of ambient package types and allow 30 seconds for its full TypeScript compile on shared CI runners.
- [FIX] Simplify profile and layout selection with searchable connection details, a setup action for missing profiles, and loading feedback; validate find inputs, honor cancellation, restore FM Web profile switching, and prevent stale connection-status updates.
- [INTERNAL] Consolidate command selection logic, correct test fixture types and checked array access, and include source and tests in the standard typecheck command.

- [FEATURE] Connection wizard now offers a **Connect Now** action immediately after a profile is saved, so first-run users flow straight from "saved" to an open session without hunting for **FileMaker: Connect** in the Command Palette. Editing an existing profile offers **Reconnect now** instead.

- [FEATURE] Added a Layout Inspector view that shows selected layout fields, portals, value lists, and field validation rules with refreshable session caching.

- Attributed the extension to ABD Enterprises in README and `package.json`:
  - new `author` field pointing at `https://abdenterprises.com`
  - `homepage` now resolves to `abdenterprises.com?ref=vscode` (with the GitHub repo still linked via `repository`)
  - README opens with an ABD attribution line and closes with a consulting-engagement table for users who need integration, migration, or modernization help

## 1.1.0

Major usability, accessibility, security, and reliability release.

### Onboarding

- Added a first-run Getting Started walkthrough (Add Profile → Test Connection → Query Builder) with screenshots and clear action verbs.
- Added a dedicated activity-bar container with a FileMaker icon.
- Added a Welcome view that surfaces **Add Connection Profile** / **Open Walkthrough** when no profiles exist (previously the empty state was buried behind always-present Environment Sets / Jobs roots).
- Connection wizard restored: fixed a crash on load caused by a missing `<form id="wizardForm">` wrapper. Save and Test Connection buttons are now reliably bound.
- Connection wizard collapses advanced server fields (`API Base Path`, `API Version`) under a `<details>` disclosure so first-time users see only what they need.
- Connection wizard shows live progress during Test Connection with phase-by-phase status.
- Walkthrough id computed from `context.extension.id` at runtime so a publisher rename can't silently break the walkthrough; the first-run flag is now only set after the walkthrough opens successfully.

### Connection / Status

- Added a persistent `$(plug) FileMaker: <profile>` status-bar item so you always know whether you're connected and to which profile. Click to open the Explorer.
- Proactive session-token refresh in `fmClient` keeps long-running sessions alive without manual reconnect.
- Exponential-backoff retry on transient login errors during Connect.
- Inline Test Connection result + save guard: badge shows untested / passed / failed / stale; configurable policy (`off` / `warn` / `block`) controls whether saving without a recent test is allowed.

### Errors & Recovery

- Error toasts now offer **Retry / Edit Profile / Open Settings** actions inline. Retry re-invokes the original command; Edit Profile reopens the wizard for the failing profile; Open Settings jumps to the relevant setting key.
- Structured error reports with the full request chain, redacted headers, and a one-click **Copy as Bug Report** action that produces a markdown report safe to paste into an issue.
- Graceful fallback in `secretStore` when VS Code SecretStorage is unavailable (AES-256-GCM PBKDF2 envelope).
- Offline-mode status-bar indicator with stale-cache awareness.
- Circuit-breaker registry plus **Show Circuit Breaker Status** command for diagnosing repeated failures.

### Accessibility

- Connection wizard required fields now mark `aria-required`, render a visible `*`, and link hints via `aria-describedby` so screen-reader users get full context.
- Authentication mode toggle exposes proper `aria-pressed` state.
- Password / username inputs include `autocomplete` hints.
- Focus management: focus lands on the first input on open; Query Builder focuses the profile select after init.

### Discoverability

- Command palette flood: ~33 commands gated behind context keys (`filemaker.hasProfiles`, `filemaker.hasSchemaSnapshots`, `filemaker.enterpriseMode`, `filemaker.advanced.powerUserMode`). New users see only what's relevant; advanced/diagnostic commands stay hidden until needed.
- Power-user mode setting unlocks plugin / circuit-breaker / diagnostics commands.

### Settings

- Deduplicated `filemakerDataApiTools.*` settings under the canonical `filemaker.*` namespace. Legacy keys now carry `markdownDeprecationMessage`; explicit values continue to be honored with a one-time deprecation toast pointing at the new key.
- Validation: `filemaker.schema.hashAlgorithm` is checked against `crypto.getHashes()` at activation; an unsupported value surfaces a toast instead of a silent fallback.
- Declared `capabilities.untrustedWorkspaces` so VS Code's built-in trust banner fires up front (instead of bespoke command-level toasts).

### Documentation

- Rewrote USER_GUIDE.md connection sections to match the actual webview UI (the previous copy described a quick-pick flow that no longer existed).
- Walkthrough markdown gained screenshots reused from the marketplace assets.
- Corrected an incorrect tip claiming profiles were workspace-scoped; profiles are global, only saved queries are workspace-scoped.

### Security & Reliability

- Token-bucket rate limit plus per-session request budget on the FM bridge server.
- Profile cache keys versioned (`v2::`) and include the normalized `serverUrl` to prevent cross-profile cache poisoning.
- Documented proxy threat model; minimized outbound profile payload.
- Structural validator for inbound webview messages.

### Performance

- Replaced 59 per-command `activationEvents` with `onStartupFinished` and lazy command registration.
- `batchExportFind` now streams CSV rows instead of buffering the entire result set.
- Refactored `fmClient` to extract `SessionTokenTracker` for clearer proactive-refresh state.

### Tests

- New unit-test coverage for `schemaService`, `batchService`, error-action selection, deprecated-setting tracking, command-resolution helpers, connection status bar, and webview structural assertions (catches the kind of HTML/JS mismatch that hid the wizard form bug).

## 1.0.0

Production release.

- Complete CRUD: find, get, create, edit, delete records
- Value list support with extraction and explorer integration
- Container field detection and URL resolution
- Portal data utilities with pagination parameters
- Global field support with payload builder/parser
- Compound find queries with omit support
- Duplicate record preparation with auto-enter field filtering
- 253 tests across 58 test files
- Coverage reporting with @vitest/coverage-v8
- Webview rendering stability (loading skeletons, targeted DOM updates, debouncing)
- Responsive CSS with fluid scaling and ARIA accessibility
- Enterprise role guards and workspace trust enforcement
- VS Code Marketplace publishing workflow in CI

## 0.9.0

- Global field support:
  - Added `buildGlobalFieldsPayload()` and `parseGlobalFieldsPayload()` utilities
  - Added `isValidGlobalFieldName()` validation
- Compound find support:
  - Added `buildCompoundFindQuery()` for multi-request finds with omit support
  - Added `parseCompoundFindQuery()` for parsing query arrays back to structured rows
  - Added `validateCompoundFind()` validation
- Duplicate record support:
  - Added `extractDuplicateFieldData()` and `prepareDuplicateFieldData()` utilities
  - Added `isLikelyAutoEnterField()` heuristic for excluding auto-enter fields
- Tests:
  - 10 global field tests, 7 compound find tests, 6 duplicate record tests
  - Total: 253 tests across 58 test files

## 0.8.0

- Portal support:
  - Added `extractPortals()` utility for structured portal data extraction from records
  - Added `extractPortalMetadata()` for parsing portal field metadata from layout info
  - Added `buildPortalParams()` for portal-aware find/get request parameters (limit, offset per portal)
  - Portal field names extracted and sorted, internal fields (recordId/modId) filtered
- Tests:
  - 12 portal utility tests (extraction, metadata, params, edge cases)
  - Total: 226 tests across 55 test files

## 0.7.0

- Value list support:
  - Added `ValueList` and `ValueListItem` types
  - Added `extractValueLists()` utility for parsing layout metadata
  - Value Lists group node in Explorer under each layout
  - Value list items displayed with item count
- Container field support:
  - Added `isContainerField()` utility for field type detection
  - Added `resolveContainerUrl()` for building full download URLs from relative paths
  - Added `isImageContainer()` for detecting image content types
- Tests:
  - 7 value list parser tests (extraction, edge cases, fallbacks)
  - 9 container field utility tests (detection, URL resolution, image detection)
  - Total: 214 tests across 54 test files

## 0.6.0

- Webview rendering stability:
  - Added loading skeleton states to all webviews (no more empty form flash)
  - Replaced full DOM rebuilds with targeted element updates in recordEditor, queryBuilder, recordViewer, scriptRunner
  - Added 200ms debounce to recordEditor field input handlers
  - Fixed layout thrashing in queryBuilder virtual table scroll handler (requestAnimationFrame)
  - Lowered virtualization threshold from 250 to 50 rows
  - Added fade-in transitions for schema diff sections
- Responsive CSS improvements:
  - Fluid max-width, clamp-based font sizing, fluid padding across all webviews
  - Removed fixed min-width on tables (horizontal scroll wrapper instead)
  - Added ARIA attributes for accessibility (aria-live, role=status)
- Test coverage expansion:
  - Added coverage reporting with @vitest/coverage-v8 and lcov output
  - Added ProxyClient unit tests (13 tests covering all public methods)
  - Added command handler tests (registration, common utils parsing)
  - Added webview HTML snapshot tests (CSP nonce, directives, DOM structure)
  - Added fmExplorer tree view tests (root nodes, profile children, refresh)
  - Added utility tests for errorUx, hash, jsonlWriter, csp
  - Added integration tests for createRecord and deleteRecord
  - Total: 191 tests across 52 test files
- Added Create Record support:
  - createRecord method in FMClient and ProxyClient
  - RecordEditor create mode (custom title, confirmation, success message with recordId)
  - FileMaker: Create Record command with layout picker
  - Explorer context menu on layout nodes
- Added Delete Record support:
  - deleteRecord method in FMClient and ProxyClient
  - FileMaker: Delete Record command with confirmation dialog
  - Deletion blocked for viewer role and untrusted workspaces
- Security:
  - Bumped axios 1.13.6 to 1.15.0 (SSRF and header injection fixes)
  - Bumped next 15.5.14 to 15.5.15 (DoS fix)
  - Added npm audit step to CI pipeline

## 0.5.1

- Fixed layout parsing for folder-based FileMaker layout payloads:
  - nested folder nodes are now flattened into selectable layout names
  - layouts under folders (for example `Assets`) now resolve correctly in Query Builder and Explorer
- Added tests for folder/nested layout parsing:
  - unit coverage for mixed layout structures
  - integration coverage for mocked `/layouts` folder responses
- Fixed VSIX packaging defaults:
  - removed `--no-dependencies` from package script to avoid missing runtime modules in installed VSIX files

## 0.5.0

- Quality/hardening release (no major new user-facing feature set).
- Added centralized settings service:
  - defaulting and validation/clamping for key settings
  - trust-aware defaults for snapshot storage/file output flows
- Added shared error infrastructure:
  - typed normalized error model (`src/types/errors.ts`)
  - shared `normalizeError()` utility
  - shared command error UX helper with `Details…` JSON document
- Added shared redaction utility and migrated logging call sites:
  - centralized token/password/header redaction
  - history/job/log pathways aligned on common redaction behavior
- Hardened webviews:
  - common CSP nonce builder
  - message validation helpers for inbound postMessage payloads
  - stricter CSP usage across webview surfaces
- Hardened data client behavior:
  - broader normalized error mapping (auth/server/network/timeout/cancellation)
  - cancellable proxy calls and improved propagation of abort signals
- Validation/sanitization improvements:
  - stronger profile input validation (URL/database/profile IDs)
  - safer output path/file-name handling for generated artifacts
- Testing expansion:
  - new unit tests for normalizeError, redact, settingsService, message validation
  - additional unit/integration coverage for fmClient headers and timeout/abort/non-JSON handling
- CI updates:
  - format check step
  - package validation step
  - stricter lint gate (`--max-warnings=0`)
- Documentation overhaul:
  - refreshed README and ARCHITECTURE
  - added CONTRIBUTING, SECURITY, UPGRADE guides

## 0.4.0

- Added enterprise governance foundations:
  - environment sets (`create/list/store`) for grouped profile workflows
  - cross-environment comparison service with layout presence matrix
  - layout diff across environments with field-level drift output
  - comparison export to JSON/Markdown
  - environment set explorer section and commands
- Added role-based feature controls:
  - `filemaker.enterprise.mode` and `filemaker.enterprise.role`
  - command-layer restriction enforcement (viewer/developer/admin)
  - locked profile handling via enterprise config policy
  - enterprise config parsing from `.vscode/filemaker.config.json`
- Added observability and diagnostics:
  - request tracing with `requestId`
  - rolling metrics store (latency, success/failure, re-auth, cache hit)
  - diagnostics dashboard webview
  - logger support for `filemaker.logging.level`
- Added high-scale performance hardening:
  - `filemaker.performance.mode`
  - high-scale batch export behavior (JSONL-first)
  - adaptive concurrency controller
  - retry/backoff for 429/5xx
  - circuit-breaker protection for repeated batch-update failures
- Added plugin architecture:
  - plugin contracts (`pluginTypes`)
  - plugin lifecycle and loading registry
  - internal + trusted workspace plugin loading
  - safe plugin API wrapper without SecretStorage exposure
  - plugin commands (`Reload Plugins`, `List Active Plugins`)
- Added offline metadata mode:
  - `filemaker.offline.mode`
  - persistent metadata cache store under `.vscode/filemaker/offline-metadata`
  - explorer offline badge
  - toggle offline mode and refresh cache commands
  - schema service cache fallback in offline mode
- Updated explorer structure:
  - `Environment Sets` root
  - `OFFLINE MODE` badge root item when enabled
- Expanded test coverage:
  - unit tests for role guard, environment compare, metrics, adaptive concurrency, circuit breaker, plugin registry, environment set store
  - integration tests for environment compare, offline mode, high-scale export behavior, role guard restrictions

## 0.3.0

- Added schema snapshots and schema diff workflows:
  - capture snapshots per profile/layout
  - workspaceState or workspace-files storage backend
  - diff two snapshots or diff current metadata vs latest snapshot
  - schema diff webview with added/removed/changed sections
  - optional Problems diagnostics publishing for drift detection
- Added type/snippet generation:
  - TypeScript layout artifacts generated into configurable output folder
  - field-name sanitization + mapping constants
  - metadata hash header for rerunnable generation traceability
  - VS Code snippet generation for find/get-record flows
- Added record editing write-back support:
  - new Record Editor webview
  - draft validation + dirty-state handling
  - preview patch JSON before save
  - partial update save via Data API edit endpoint
  - explicit save confirmation with rollback guidance
- Added batch operations + job runner:
  - batch find export with pagination (JSONL/CSV)
  - batch update from CSV/JSON with dry-run default
  - bounded concurrency execution and cancellation support
  - job progress/status tracking + status bar integration
  - persisted recent job summaries
- Hardening improvements:
  - improved cache keys (profile/database/api path aware)
  - best-effort ETag handling for metadata fetches
  - workspace trust gating for file-output and batch features
  - expanded settings surface for v0.3 features
- Added CI workflow:
  - npm install, lint, test, build
  - optional packaging step on tags
- Added tests:
  - unit tests for schema diff, name sanitize, type generation, job runner
  - integration tests for editRecord, snapshot+diff, batch export and batch update behavior

## 0.2.0

- Added Saved Queries v2:
  - workspace/global scope setting
  - schema versioning + migration from v0.1 format
  - run/open/manage/delete/export/import commands
  - explorer integration under profile nodes
- Added schema/field metadata browser:
  - `Fields` tree under layouts
  - metadata cache with TTL
  - graceful unsupported handling
  - refresh schema cache command
- Added Script Runner webview + command:
  - run scripts with layout/context inputs
  - copy as curl/fetch helpers
  - unsupported detection and UI guardrails
- Upgraded Query Builder:
  - load saved query defaults
  - save current query command integration
  - export JSON to editor/file and CSV to file
  - history panel
  - copy as curl/fetch with auth-inclusion toggle
- Added request history store + command (`Show Request History`)
- Added utilities:
  - JSON validation helper
  - CSV exporter
  - snippet generator with default auth redaction
- Added/expanded tests:
  - saved queries store
  - JSON validation
  - snippet redaction
  - CSV escaping
  - history ring buffer
  - schema metadata integration
  - script runner integration
  - saved query run integration

## 0.1.0

- Initial MVP release:
  - Connection profiles with secure secret handling
  - FileMaker Explorer tree view (profiles + layouts)
  - Query Builder and Record Viewer webviews
  - FileMaker Data API client with token lifecycle and 401 retry
  - Direct and proxy auth modes
  - Unit and integration tests (mocked HTTP)
