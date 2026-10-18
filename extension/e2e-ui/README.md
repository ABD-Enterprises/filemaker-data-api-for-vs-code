# Real VS Code UI end-to-end tests

These tests drive the **real VS Code desktop app** (downloaded by `@vscode/test-electron`) with the **built VSIX** installed,
against the **mock FileMaker Data API** (`../test/mock-server`), the way a user would: command palette, webview wizards and
panels, modal dialogs, status bar, Explorer, settings. They are not part of `npm test` or CI (they need a display and a
download of about 300 MB). Without a prerequisite they print why and exit 0.

## Run

```bash
npm ci                                  # repo root
npm run build -w shared                 # the production bundle needs shared/dist
cd extension && npm run package:check   # builds ../artifacts/filemaker-data-api-tools-<version>.vsix (the production bundle)
npm run test:e2e-ui                     # everything (about 40 minutes), report in ../artifacts/e2e-ui/<timestamp>/
E2E_ONLY=j02,j05 npm run test:e2e-ui    # some journeys (prefix match on the file name)
```

Environment: `E2E_ARTIFACTS` (output folder, default `<repo>/artifacts/e2e-ui/<timestamp>`, git-ignored),
`E2E_VSCODE_VERSION` (default `stable`), `E2E_VSCODE_CACHE` (download cache, default `<tmp>/fm-e2e-vscode-cache`),
`E2E_VSIX` (VSIX path). On Linux without a display run `xvfb-run -a npm run test:e2e-ui`.

A VS Code window opens on your desktop while the tests run and takes focus; leave the machine alone. Everything the tests
create lives under one temp folder (user data, extensions, `HOME`, workspace), removed at the end; VS Code is started with
`--use-mock-keychain`, so the macOS Keychain and your own VS Code profile and extensions are never touched. Nothing is
signed in: the first-run "Welcome to VS Code / Sign in to GitHub Copilot" overlay is dismissed with "Continue without Signing In".

## Output

`report.md` / `report.json`: one row per step with the expectation, the result (PASS, FAIL, NOTE, NOT-TESTABLE), the
screenshot path and details. `screenshots/` has a PNG per step, `vscode-logs/` the VS Code and extension host logs.
A FAIL row is a finding: the detail says what was seen. Rows in the 13a/13b/13c journeys assert the _recommended_ behaviour
from `docs/FILEMAKER_FAILURE_MODES.md`, so a FAIL there confirms a gap.

## Why Playwright's Electron support (the harness decision)

| Option                                                | Verdict                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Playwright `_electron.launch` on the real VS Code | **Chosen.** One dependency (`playwright-core`, no browser download). The real desktop build, custom (DOM) dialogs via `window.dialogStyle: custom`, and `files.simpleDialog.enable` for open/save dialogs, so everything is scriptable. Webviews are nested iframes (`vscode-webview://.../fake.html`); `page.frames()` reaches them. Isolation by `--user-data-dir`, `--extensions-dir`, `HOME`. |
| (b) vscode-extension-tester (ExTester)                | Needs Selenium plus a chromedriver matching VS Code's Electron, a second download that breaks on every VS Code update. Its page objects do not cover the extension's webviews, so most steps would still be raw DOM. Slower.                                                                                                                                                                      |
| (c) `code serve-web` in a browser                     | Tests the web build, not the desktop app: no native secret storage, no OS dialogs, a different extension host. Several journeys (trust, MCP socket, kill -9 of the extension host) would not be the same code path.                                                                                                                                                                               |

Computer-use screen control cannot type into VS Code, so nothing here uses it.

## Layout

- `run.mjs` orchestrator; `lib/session.mjs` (launch, palette, pickers, modals, webview frames), `lib/flows.mjs`, `lib/observe.mjs`, `lib/mock.mjs`, `lib/report.mjs`.
- `helper-extension/` a tiny test-only extension loaded with `--extensionDevelopmentPath`. It lets the harness call `vscode.lm.invokeTool`, read settings and list extensions through JSON files. It is never packaged (`.vscodeignore` excludes `e2e-ui/**`).
- `journeys/j*.mjs` the journeys (see the table in the PR description).
