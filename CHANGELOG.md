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


### [FIX]


### [INTERNAL]


### [SECURITY]


## 1.5.0 - 2026-10-19

Minor release: no data migration, and no command or setting was removed. User-facing notes: `extension/CHANGELOG.md` and `extension/UPGRADE.md`. Entries for 1.4.0 were removed from this ledger; the user-facing ones are in `extension/CHANGELOG.md` under 1.4.0, and the rest are in git history (commits up to 8fcc234).

### [BREAKING]

- None.

### [FEATURE]

- A read-only `@filemaker` chat participant for VS Code's Chat view (ADR-0005): `/layouts`, `/describe`, `/find` (`Field=value` or plain words that the chosen language model turns into a search, which the extension validates like any tool call) and `/explain`. It uses the AI tools through the same core, so every AI setting, approval, limit, hidden-field rule and the kill switch apply; it offers no write or script command and sends the model only layout and field names and your words, never record values or connection details. Everything from the database is shown as plain text in code blocks (never as a link, image or button), and calls are logged as client `chat participant`. No new setting; the editor floor stays 1.96. See the User Guide, "Chat with @filemaker".
- Copy a request as curl, fetch(), a `.http` file, a Postman v2.1 collection or TypeScript from the Query Builder, Script Runner, Record Viewer, Record Editor and the new `FileMaker: Copy Request as Code…` command; secrets are never copied, values are escaped per format, and Run script is copied as the documented `GET`. User-facing notes: `extension/CHANGELOG.md`.

### [FIX]

- On Windows, **Write AI Context** and the FM Web runtime generator can now update a file that is marked read-only (for example by a version-control tool): the update used to fail with `EPERM`, where macOS and Linux replaced it. The file stays read-only afterwards.
- On Windows, `npm run build` no longer needs `sh` on the PATH, and `npm run package:check` writes `filemaker-data-api-tools-<version>.vsix` instead of a file literally named `...-${npm_package_version}.vsix`; both steps are now Node scripts that behave the same in cmd.exe, PowerShell and a POSIX shell.
- On Windows, a repository checked out with `core.autocrlf` (the Git for Windows default) no longer fails `npm run package:check` or the mock dataset check because generated files such as `THIRD_PARTY_NOTICES.txt` came out with CRLF line endings: `.gitattributes` now keeps LF in the working tree on every platform, and both checks also ignore CRLF.
- The build commit shown by **About** is now found on Windows when the temp or checkout path contains an 8.3 short name or a different drive-letter case (it said `unknown`).
- On Windows, the MCP shim waits up to 30 seconds (it was 8) for PowerShell to report the process start time before it gives up and refuses to connect: PowerShell takes about 2 seconds to start on an idle machine and much longer on a busy one.
- An MCP client configured with `--workspace C:\Work\Alpha` now matches the window VS Code reports as `c:\work\alpha` (folder paths are compared without regard to case on Windows).
- A malformed `filemaker.ai.hiddenFields` value no longer switches hiding off for the whole scope: non-text entries are ignored and the valid names in the same list still hide (a bare string counts as one name), and the Output panel says so once.
- Refreshing a generated FM Web runtime file now keeps the file permissions of the file it replaces, and a write that fails part way (for example a full disk) no longer leaves a hidden `.tmp` file in the generated folder.
- The AI server for external tools now writes a line to the Output panel when it rejects a socket folder (for example an `XDG_RUNTIME_DIR` that is open to other users) before falling back to the temp folder, and the error names each folder variable that was tried instead of only the last one (a too-long socket path now names the variable actually in use).
- After an untrusted-certificate failure the extension looks at the server certificate once per server and failure for a minute (the result is remembered, including a look that got no answer), instead of paying up to 1.5 s on every failed request.
- Scripts run with the request the Claris Data API Guide documents: `GET .../layouts/<layout>/script/<script>?script.param=<text>`. Before, the extension first sent a `POST` to that address (which the Data API does not accept) and then fell back to a find with the script attached, so every script run also read a record. A script run is now one request that reads nothing. Parameters are percent-encoded exactly (a space is `%20`, never `+`; unicode, `|`, `&` and `/` survive). A parameter too long for a URL (about 2,000 characters, as the guide advises) goes in the body of a find limited to one record, the guide's other documented form; with a record id and a too-long parameter you get a clear error instead. The attach-to-another-request form is used only when the server refuses the script endpoint (405, 501 or a FileMaker 404). Script Runner's Copy as curl / fetch now shows the same GET request.
- Running a script refuses a script or layout named `.` or `..` with a clear message before anything is sent (a web address would resolve it away and send a different request that reported success), in the client, Script Runner and the AI tool. A script run now returns only the script's answer: when the script is attached to a record or a find, the record's `data` and `dataInfo` are dropped before Layout Mode, the preview bridge or any other caller sees them.
- Mid-response connection drops are reported clearly instead of as (HTTP 200).
- Refresh Schema Cache re-reads the layout list.
- Layout names are no longer trimmed; spacing/case variants stay distinct.
- The Record Editor no longer hides the fact that fields are missing. A note above the field list says that fields your account cannot access are not shown, and when the layout lists fields that the record has no value for it says how many and names them (up to five).
- The Record Viewer no longer sits on a loading skeleton. Opened for a record (from a results row, for example) it loads that record by itself; opened without one it shows the form with the hint 'Enter a record ID and select Load Record.'; a failed load shows its error.
- The connection wizard says when the workspace is in Restricted Mode. A notice at the top explains what is limited (a profile template in the project is ignored; workspace settings that change how connections and commands behave are ignored until you trust the workspace) and has a **Manage Workspace Trust** button; it disappears when you trust the workspace.
- Panels fit narrow editors. A very long layout name no longer widens the layout drop-down (and the whole page) in the Record Editor, Record Viewer and Script Runner: long names are clipped with the full name in the tooltip; buttons wrap; long values break instead of overflowing. The connection wizard's Test button, the Query Builder's menus and request history, the Diagnostics tables (they now scroll inside their cards), and Layout Mode (its three columns narrow, then stack in one scrolling column) work from 360 px up. Measured with the real-VS-Code responsive audit (J14, 164 states at 360-1100 px, zoom -2 to +2, light, dark and high-contrast themes): 77 failing states before, 0 after.
- Layout, script and field names are now used exactly everywhere. With layouts `Sales` and ` Sales` (a leading space), choosing ` Sales` no longer turns into `Sales`: a container upload, a script run (Script Runner, Layout Mode, AI tool), a saved query and type generation all use the exact name, so nothing is written to the wrong layout. Generated type files, TypeScript identifiers and VS Code snippet keys for such layouts stay distinct. The Record Editor's hidden-fields note appears only when the layout lists fields the record lacks.
- The **Upload to Container** command, the only route to a container upload, keeps the field name exactly as typed or given (a field named ` Photo` is no longer sent as `Photo`); global field names and the FM Web synced field list are kept exactly as well.
- Script names read from the server and field names chosen in the Query Builder's find form and sort are kept exactly (a leading or trailing space is part of the name), like layout names.

### [INTERNAL]

- Dependencies updated: `zod` 4.6.5 and a round of development tools (`vitest` 5, `@types/node`, `eslint`, `globals`, `prettier`, `@vitest/coverage-v8`); `THIRD_PARTY_NOTICES.txt` regenerated.
- Compatibility page wording made factual (21.x targeted, not yet verified on a real server; 19.x, 20.x and proxies expected to work, not tested), keychain troubleshooting wording matches the logged message, walkthrough step 4 image. User-facing notes: `extension/CHANGELOG.md`.
- Marketplace page and User Guide refreshed for the changes since 1.4.0: real screenshots from the real-VS-Code UI harness against the mock Data API (new journey `e2e-ui/journeys/j16-marketplace-screenshots.mjs`, run by hand with `E2E_MARKETPLACE=1`) replace the three drawn mock-ups, and the guide describes the `@filemaker` participant, copy as code, the documented script `GET` and its 2,000-character limit, exact names, the Restricted Mode notice and Windows/Linux notes. User-facing notes: `extension/CHANGELOG.md`.
- New `cross-platform` CI job: build, lint, typecheck, unit tests with coverage and package check on `windows-latest` and `ubuntu-latest` (Node 22). It is not a required check. New Windows-only tests run a real named-pipe MCP server and clients, real directory junctions through the discovery, shim-install, path-confinement and FM Web generator checks, read-only file replacement, and an `icacls` check of the discovery file's access rights; several MCP discovery tests that were Unix-only now run on Windows too.
- Tests no longer assume Unix: path separators in expectations, a regular file instead of `/dev/null` as an unwritable folder, backslashes in the mock TLS authority's OpenSSL configuration, and CRLF-tolerant reads of `.vscodeignore`.
- Dependabot now also watches `tools/publish` (the pinned Marketplace publish tool), which has its own lockfile and was not covered before.

### [SECURITY]

- Log and diagnostics redaction now also covers single-quoted keys (`{'token': '...'}`) and plain-text `Cookie:`, `Set-Cookie:`, `Authorization:` and `Proxy-Authorization:` lines.
- Configured file paths (for example `filemaker.ai.contextPath`) now also reject characters that render as blank (Hangul fillers, variation selectors, the combining grapheme joiner), so a path cannot look like a different one.
