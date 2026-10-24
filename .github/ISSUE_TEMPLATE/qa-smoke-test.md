---
name: "QA: Smoke test"
about: Manual release smoke test run. Tick boxes as you go.
title: "vX.Y.Z QA: smoke test — <YOUR_INITIALS> <DATE>"
labels: ["qa", "smoke-test"]
assignees: []
---

> Run the checks in [extension/docs/QA/SMOKE_TEST.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/QA/SMOKE_TEST.md). Tick boxes here as you go.
>
> Replace the placeholders in the title with the version, your initials and the date (e.g. `v1.4.0 QA: smoke test — AD 2026-10-20`).

## Environment

- Extension version: _e.g. 1.4.0_
- VS Code version: _e.g. 1.96.2_
- Operating system: _e.g. macOS 15 / Windows 11 / Ubuntu 24.04_
- Installation method: _Marketplace / VSIX_
- Server: _real FileMaker Server (version) / mock Data API_
- Test account has `fmrest` privilege: _Yes / No_

## Release-blocking checks

- [ ] **1** Install, version and publisher
- [ ] **2** First run: walkthrough and welcome view
- [ ] **3** Command Palette with no profile
- [ ] **4** Wizard failure path
- [ ] **5** Wizard success path, Connect Now, status bar
- [ ] **6** Secrets not in settings or logs; password re-asked after address change
- [ ] **7** Explorer: layouts, fields, value lists
- [ ] **8** Query Builder: run, page, sort, CSV, empty result
- [ ] **9** Record Editor: save and edit-conflict refusal
- [ ] **10** Batch export and batch update dry run
- [ ] **11** Schema snapshot and diff
- [ ] **12** Disconnect, reconnect, session expiry
- [ ] **13** Create Record
- [ ] **14** Certificates (keep VS Code's `http.proxySupport` at its default `override`, then repeat the trust and changed-certificate checks once with `fallback` and once with `on`; default certificate trust dialog, decline, changed and expired certificate, CA file, forget, proxy case)
- [ ] **15** MCP server start, stop and config

## Further checks

- [ ] **16** Generated files
- [ ] **17** Reload window
- [ ] **18** Untrusted workspace
- [ ] **19** New prompts (plugins, FM Web preview)
- [ ] **20** AI is off by default; Write AI Context
- [ ] **21** User guide opens
- [ ] **22** Uninstall

## Result

- [ ] **PASS**: all release-blocking checks green
- [ ] **FAIL**: at least one release-blocking check red (open follow-up issues and link them below)

## Failures / notes

<details>
<summary>Attach screenshots, Output panel logs or the Show Diagnostics report</summary>

_Paste here._

</details>

## Follow-up issues opened from this pass

- (list issue links)
