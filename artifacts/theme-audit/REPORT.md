Theme color work on `fix/theme-colors`, based on local release commit `5bd5dc8` (1.6.0).

Changes are in the working tree. Git staging failed with `Operation not permitted` creating `.git/index.lock`; no commit was made. No push, PR, remote operation, install, GUI, extension host or e2e-ui run was performed.

| File | Change |
| --- | --- |
| `designer-ui/src/styles.css` | Theme tokens for Layout Mode toolbar, panes, inspector, fields, console, object labels, selection handles, guides and grid. Remove the forced light color scheme. Keep neutral paper and authored page colors. Use full-contrast footer text. |
| `extension/src/webviews/recordViewer/ui/styles.css` | Theme page, panels, controls, table headers, raw values, copy menu, borders and focus. Pair button/secondary foregrounds and backgrounds. |
| `extension/src/webviews/recordEditor/ui/styles.css` | Theme page, controls, panels, raw JSON, conflict notice, copy menu, borders and focus. |
| `extension/src/webviews/scriptRunner/ui/styles.css` | Theme parameter builder, preview, page, controls, raw result, secondary actions and copy menu. |
| `extension/src/webviews/schemaDiff/ui/styles.css` | Theme diff fills and borders, use readable text rather than decoration colors for badges and metadata, pair warning foreground/background, and fall back to the editor background when HC omits a diff fill. Preserve added/removed/changed labels and colored decorations. |
| `extension/src/webviews/layoutMode/ui/index.css` | Theme fallback/loading page and footer. |
| `extension/src/webviews/queryBuilder/ui/styles.css` | Fix HC secondary fallbacks, selected-menu text pairing, muted text contrast and raw-value fallback; add contrast/focus outlines and readable placeholders. |
| `extension/src/webviews/connectionWizard/ui/styles.css` | Replace three remaining bare badge colors with paired validation tokens; fix warning/success text contrast, HC borders, controls, focus and placeholders. |
| `extension/src/webviews/environmentCompare/index.ts` | Theme inline page/card/table/footer CSS and pair semantic badges with validation colors. |
| `extension/src/diagnostics/diagnosticsDashboard.ts` | Theme inline cards, tables, labels, actions and footer, with HC button outlines. |
| `extension/src/settings/effectiveSettings.ts` | Theme background and buttons; use paired warning colors for ignored-setting messages. |
| `extension/src/webviews/common/panelRestore.ts` | Explicit editor background on restored-panel notice. |
| `extension/test/unit/themeColors.test.ts` | Scan every designer stylesheet, every extension stylesheet and inline style block/HTML style attribute, and build-generated shared field CSS. Reject hex, RGB, HSL, modern color functions and CSS named colors outside the documented allow-list. |
| `extension/test/unit/changelogStructure.test.ts` | Permit entries under Unreleased while retaining the release-order check. |
| `extension/test/unit/webviews/versionFooter.test.ts` | Require full opacity instead of requiring dimmed footer text. Geometry assertions remain. |
| `tools/theme-audit.mjs` | Offline fixtures, installed default-theme provenance, static contrast checks, strict headless Chrome screenshot attempts, and machine-readable evidence. Exits nonzero if contrast or screenshots fail. |
| `CHANGELOG.md` | Plain-language entry in Unreleased / FIX. |
| `extension/CHANGELOG.md` | Matching plain-language entry under Unreleased. |

`shared/src/field-standards.ts` and the generated `fieldStandards.css` copies contain no colors. They were audited and left unchanged; field dimensions, label space, gaps and wrapping are unchanged. Existing standard-presentation checks pass. No product JavaScript or TypeScript behavior was changed.

`runtime-next` is the generated standalone web app, not editor chrome. Its source styles and the shared renderer's authored page/object palette were deliberately left unchanged. The designed page keeps its own surface/text palette inside the themed Layout Mode chrome. Custom authored colors are outside the editor contrast contract and were not certified by this audit.

Remaining color literals:

- Exactly one direct stylesheet literal remains in editor chrome: `.design-surface { background-color: #ffffff; }`, documented as canvas paper beside the rule and in the guard allow-list.
- The other 235 color literals in the audited color inventory are fallbacks within VS Code theme-token lookups, including semantic diff and validation fallbacks. They are not unconditional palette overrides. Full per-file counts: [color-inventory.json](color-inventory.json).
- `transparent`, `inherit` and inherited colors remain where appropriate. Authored canvas/runtime palettes are intentionally outside the guard.

The regression guard passed all 8 tests. Mutation checking appended `.theme-color-mutation { color: #123456; }` to the real designer stylesheet, ran the guard and observed exit 1 identifying that declaration. The mutation was restored in a `finally` block, and the clean guard passed. Evidence: [mutation.json](mutation.json), [mutation.log](mutation.log), [focused.log](focused.log).

Contrast was computed from production CSS after resolving injected VS Code custom properties, using jsdom's cascade and alpha compositing against ancestor backgrounds. Theme JSON and inherited UI color registrations came from the installed VS Code 1.142.0 Light+, Dark+ and High Contrast themes; [theme-sources.json](theme-sources.json) records paths, registration excerpts and a source hash. Missing/null HC tokens remain absent to exercise production fallbacks.

| Theme | Static checks | Lowest text contrast | Below 4.5:1 |
| --- | ---: | ---: | ---: |
| Light+ | 735 | 4.511:1 | 0 |
| Dark+ | 735 | 4.529:1 | 0 |
| High Contrast | 735 | 7.013:1 | 0 |

There are 99 table rows: 11 pages × three themes × normal/hover/focus states. The 2,205 checks include repeated text nodes across those states. Disabled controls and authored canvas content are excluded. Placeholder foregrounds explicitly match input text but pseudo-element rendering was not measured. Hover/focus color rules are emulated in static CSS. Field metadata, semantic notices, raw values, menus, labels, buttons and inputs are sampled. The designer fixture comes from its actual built React UI; classic webview fixtures use their page templates with sample values, while inline pages use representative markup. The audit checks representative states rather than every possible dynamic result.

Detailed results: [contrast.md](contrast.md), [contrast.csv](contrast.csv), [contrast-pairs.json](contrast-pairs.json). The same folder contains 33 standalone HTML fixtures and three injected-token snapshots. Run `node tools/theme-audit.mjs` to regenerate them; set `CHROME_PATH` / `VSCODE_THEME_DIRECTORY` on another host if needed. Existing dependencies and a built designer bundle are required; the script performs no downloads.

**No screenshots were produced.** Both initial Chrome probes aborted, and each Light+/Dark+/HC screenshot invocation with `--headless=new --screenshot` terminated with `SIGABRT` before creating a PNG. Chrome emitted no diagnostic text. [screenshots.json](screenshots.json) preserves arguments and signals. This does not establish the abort's cause. The static contrast table is not a Chrome render, and browser layout, native widgets, pseudo-elements, grid appearance and final visual contrast remain unverified. The screenshot phase makes the audit script exit 1 despite its passing static contrast checks. No visible-browser fallback was used.

| Command actually run | Result | Evidence |
| --- | --- | --- |
| `npm run lint` | PASS, exit 0 | [lint.log](lint.log) |
| `npm run typecheck` | PASS, exit 0 | [typecheck.log](typecheck.log) |
| `npm run test:coverage` | FAIL, exit 1; 29 failing files, 175 passing, 2 skipped; 185 failed tests, 2,391 passed, 167 skipped; 139 reported errors | [test-coverage.log](test-coverage.log) |
| `npm run build` | PASS, exit 0 | [build.log](build.log) |
| `npm run package:check` | PASS, exit 0; local 1.6.0 VSIX generated | [package-check.log](package-check.log) |
| `npm exec -w extension -- vitest run test/unit/themeColors.test.ts test/unit/changelogStructure.test.ts test/unit/webviews/versionFooter.test.ts test/unit/webviews/standardFieldSurfaces.test.ts` | PASS, 36 tests / 4 files | [focused.log](focused.log) |
| `npm exec -w designer-ui -- vitest run src/standard-presentation.test.tsx src/field-standards.test.ts src/field-fidelity.test.tsx` | PASS, 25 tests / 3 files | [designer-focused.log](designer-focused.log) |
| `node tools/theme-audit.mjs` | Static contrast PASS; screenshot phase FAIL, exit 1 | [audit.log](audit.log), [screenshots.json](screenshots.json) |
| `git diff --check` | PASS | Final local diff check |
| `git add` (explicit list of 18 changed/new source files) | FAIL, exit 128; index.lock permission denied | [git-stage.log](git-stage.log) |

The first coverage run exposed two obsolete assertions (empty Unreleased and mandatory footer opacity); those were corrected and pass in the final coverage and focused runs. [test-coverage-initial.log](test-coverage-initial.log) preserves that earlier run. The final remaining coverage failures are socket/process-dependent tests; the log shows `listen EPERM` for TCP/Unix listeners, blocked process operations (`spawn EPERM`), mock-server startup failures, cleanup failures after a refused listener, and listener-dependent timeouts. The hardening test expecting a socket-permission error instead encounters `listen EPERM` earlier. This is evidence of sandbox interference, not a successful coverage gate; rerun outside the sandbox before delivery. No coverage-threshold pass is claimed.

All failing files are listed below (paths relative to `extension/`). Full failed suite/test names are in [coverage-failed-tests.txt](coverage-failed-tests.txt); [coverage-errors.json](coverage-errors.json) retains reported error messages.

- `test/integration/tlsOverrides.integration.test.ts`
- `test/unit/ai/aiEndToEnd.test.ts`
- `test/unit/ai/mcp/mcpBasics.test.ts`
- `test/unit/ai/mcp/mcpController.test.ts`
- `test/unit/ai/mcp/mcpEndToEnd.test.ts`
- `test/unit/ai/mcp/mcpServer.test.ts`
- `test/unit/ai/mcp/mcpServerHardening.test.ts`
- `test/unit/certificatePinning.test.ts`
- `test/unit/clarisDefaultCertificate.test.ts`
- `test/unit/commands/containerUploadExactNames.test.ts`
- `test/unit/credentialLatch.test.ts`
- `test/unit/exactLayoutNames.test.ts`
- `test/unit/extraCaCerts.test.ts`
- `test/unit/fmBridgeToken.test.ts`
- `test/unit/fmWebRuntimeTemplate.test.ts`
- `test/unit/mockServer/mockClarisDefaultCert.test.ts`
- `test/unit/mockServer/mockContract.test.ts`
- `test/unit/mockServer/mockDataset.test.ts`
- `test/unit/mockServer/mockFaults.test.ts`
- `test/unit/pinnedCertificateProxy.test.ts`
- `test/unit/pinnedSessionResume.test.ts`
- `test/unit/recordEditorCreate.test.ts`
- `test/unit/responseValidation.test.ts`
- `test/unit/reviewFollowUps.test.ts`
- `test/unit/scriptEndpoint.test.ts`
- `test/unit/sessionHealth.test.ts`
- `test/unit/snippets/mockExecution.test.ts`
- `test/unit/tlsAgentLifecycle.test.ts`
- `test/unit/tlsFailures.test.ts`

Artifacts are local and untracked. No source/generated bundle, screenshot, contrast-table or test result has been published.
