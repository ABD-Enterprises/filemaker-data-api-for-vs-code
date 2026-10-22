# FileMaker Data API Tools 1.7.0 preparation

Prepared locally on `release/v1.7.0`, based on `a930b4802474c019ed1e0cc05489cc5318cbd7df` (local main and cached origin/main). No network, installs, GUI, remotes, commits, tags, push or PR operations were performed. Cached Git references cannot prove the current online branch or CI status.

## Changes

Version 1.7.0 is set in extension/package.json and the root lockfile's extension entry: exactly one changed line in each. There are no production source changes. The user changelog is ordered by safety/features, then fixes and maintenance, with a new empty Unreleased heading. The root ledger starts a fresh five-section Unreleased and archives 1.7.0, removing the prior ledger section while keeping its user notes. Upgrade notes cover prompts, record versions, field access, exports, certificate/proxy routes, connection reports, jobs, saved queries, settings defaults and rollback. READMEs, the user guide and command table, compatibility, failure modes, release instructions, security/data handling and walkthrough text are updated.

Tracked files changed:

- `CHANGELOG.md`
- `README.md`
- `docs/DATA_HANDLING.md`
- `docs/FILEMAKER_FAILURE_MODES.md`
- `docs/JOB_AID_MANUAL_RELEASE.md`
- `docs/RELEASE.md`
- `docs/security.md`
- `extension/CHANGELOG.md`
- `extension/README.md`
- `extension/UPGRADE.md`
- `extension/docs/COMPATIBILITY.md`
- `extension/docs/USER_GUIDE.md`
- `extension/docs/walkthroughs/generate-types.md`
- `extension/docs/walkthroughs/query-builder.md`
- `extension/docs/walkthroughs/test-connect.md`
- `extension/package.json`
- `extension/test/unit/changelogStructure.test.ts`
- `package-lock.json`

Generated files in artifacts/ are untracked local outputs, not source changes or a published release.

## Gates actually run

| Command | Result |
| --- | --- |
| npm run lint | Passed on the final test source. |
| npm run typecheck | Passed after fixing an optional lockfile-entry assertion in the new test. |
| npm run test:coverage | Failed: extension 32 failed / 221 passed / 2 skipped files; 205 failed / 4525 passed / 176 skipped tests; 152 unhandled errors. No passing coverage percentage or threshold result is claimed. |
| npm run build | Passed for the root workspaces. Packaging also rebuilt successfully. |
| npm run package:check | Passed: notices current, versioned VSIX built and archive validated. |
| npm test -w designer-ui -w runtime-next | Passed: 61 designer and 18 runtime tests, without opening a browser or VS Code. |
| Focused changelogStructure + manifestListing tests | Passed: 2 files, 10 tests after mutation restoration. |
| npm run notices -w extension | Passed; the tracked notices did not change. |
| git diff --check | Passed. |

The three revised release tests first failed against the old release files. Five temporary mutations were caught, each restored in a finally block: (1) append a date to the extension release heading (also makes release-notes.sh fail); (2) leave a shipped entry under root Unreleased; (3) revert only the lockfile extension version; (4) change the job aid upgrade check to 1.7.0 -> 1.7.0; (5) remove Diagnose Connection from the command reference. The focused suite then passed again. No production behavior changed in this task.

## Socket/process restrictions

The full run recorded TCP, TLS and Unix socket listen EPERM, early mock exits and dependent 5-second timeouts. MCP process-start-time checks also recorded spawn EPERM (the sandbox refuses process inspection). This is a failed gate, not a substitute pass; the orchestrator must rerun outside the sandbox. The full log is `test-coverage-v1.7.0.log`; the file list is also in `coverage-failures-v1.7.0.txt`.

- `extension/test/integration/connectionDiagnostics.integration.test.ts`
- `extension/test/integration/tlsOverrides.integration.test.ts`
- `extension/test/unit/ai/aiEndToEnd.test.ts`
- `extension/test/unit/ai/mcp/mcpBasics.test.ts`
- `extension/test/unit/ai/mcp/mcpController.test.ts`
- `extension/test/unit/ai/mcp/mcpEndToEnd.test.ts`
- `extension/test/unit/ai/mcp/mcpServer.test.ts`
- `extension/test/unit/ai/mcp/mcpServerHardening.test.ts`
- `extension/test/unit/certificatePinning.test.ts`
- `extension/test/unit/clarisDefaultCertificate.test.ts`
- `extension/test/unit/commands/containerUploadExactNames.test.ts`
- `extension/test/unit/credentialLatch.test.ts`
- `extension/test/unit/exactLayoutNames.test.ts`
- `extension/test/unit/extraCaCerts.test.ts`
- `extension/test/unit/fmBridgeToken.test.ts`
- `extension/test/unit/fmWebRuntimeTemplate.test.ts`
- `extension/test/unit/mockServer/mockClarisDefaultCert.test.ts`
- `extension/test/unit/mockServer/mockContract.test.ts`
- `extension/test/unit/mockServer/mockDataset.test.ts`
- `extension/test/unit/mockServer/mockFaults.test.ts`
- `extension/test/unit/mockServer/mockVscodeProxyPatch.test.ts`
- `extension/test/unit/mockServer/serverSelfTestMock.test.ts`
- `extension/test/unit/pinnedCertificateProxy.test.ts`
- `extension/test/unit/pinnedSessionResume.test.ts`
- `extension/test/unit/recordEditorCreate.test.ts`
- `extension/test/unit/responseValidation.test.ts`
- `extension/test/unit/reviewFollowUps.test.ts`
- `extension/test/unit/scriptEndpoint.test.ts`
- `extension/test/unit/sessionHealth.test.ts`
- `extension/test/unit/snippets/mockExecution.test.ts`
- `extension/test/unit/tlsAgentLifecycle.test.ts`
- `extension/test/unit/tlsFailures.test.ts`

## Job aid and release checks

- `bash tools/release-notes.sh v1.7.0` was run and read. The job aid's file-writing form was also run: 30 lines; its `grep -c 'Upgrading from 1.6.0 to 1.7.0'` prints 1.
- Historical job aid check: local 1.4.0 package version verified at 8fcc234; notes extraction prints 83 lines and the 1.3.0 -> 1.4.0 heading check prints 1. No historical tag or release was created.
- Version inspected inside the new VSIX: 1.7.0. Source map count in the VSIX: 0. Size checked against 3 MiB. SHA-256 generated and verified. Source-map archive contains aiMcpShim.js.map, extension.js.map and schemaDiffWorker.js.map from the packaging build. See SHA256SUMS.txt and maps/sourcemaps-v1.7.0.tgz.
- Setting defaults compared directly with the 1.6.0 manifest: no default changed. The command table coverage test passes. Listing manifest fields reviewed, and local README, user guide and walkthrough file links checked. External links were not fetched.
- RELEASE_SHA's job aid default now searches for `[minor] Release 1.7.0`; no merge commit exists yet, so resolving and checking out that future SHA cannot be verified during uncommitted preparation.

## Screenshots and walkthroughs

All ten marketplace PNGs and all five walkthrough pages were inspected locally. Images were not regenerated. Text updates add the empty-search choice, generation overwrite choices, output-folder restrictions and connection reports.

| Image | Review |
| --- | --- |
| about.png | Outdated version/build: 1.4.0. |
| connection-setup.png | Old sidebar version 1.4.0; the illustrated upper form remains recognizable. Does not show newer trust or Save anyway feedback. |
| explorer.png | Old sidebar version 1.4.0; illustrated normal layout still applies. |
| record-editor.png | Outdated field presentation and theme: old table/light panel in a dark editor, plus 1.4.0 sidebar. Does not show read-only field notes. |
| layout-mode.png | Outdated controls, alphabetic field order, theme and 1.4.0 labels; missing standards/templates. |
| schema-diff.png | Old version labels and older styling; illustrated field addition/removal still applies. |
| chat-participant.png | Old panel version label 1.4.0; still illustrates read-only chat with the documented stand-in model. |
| query-builder.png | Populated search still illustrates the workflow; does not illustrate the new empty-search action or export menu. |
| copy-as-code.png | Illustrated request formats still match; does not illustrate export options. |
| icon.png | Still matches the listing icon. |

## Unverified or undone

No live FileMaker server, real TLS-inspecting proxy, complete version-specific smoke test, clean VS Code profile, upgrade-install test, rendered guide/walkthrough check or live Marketplace check was run. No npm audit was run because network access is forbidden. No install was run. The October 21 server exercise is prior owner-supplied evidence, not a new run: one server, version not recorded. Cloud/Claris ID sign-in remains unsupported. No current online CI, publishing identity state, open PR/issue state or external link availability was checked. Future merge/tag/publish and post-release checks remain the owner's work.

## Six-line owner summary

1.7.0 helps prevent batch updates from overwriting newer work.
Calculated, summary and container fields are clearly read-only in the editor.
Connection reports explain server, certificate and proxy problems.
Exports preserve text and record versions, and jobs keep partial results.
Release documents and the package are prepared locally and left uncommitted.
Coverage needs an outside-sandbox rerun; Cloud sign-in remains unsupported.
