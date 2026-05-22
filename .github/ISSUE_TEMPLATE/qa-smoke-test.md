---
name: "QA: Smoke test"
about: Manual first-time-user smoke test run. Tick boxes as you go.
title: "v1.1.0 QA: smoke test — <YOUR_INITIALS> <DATE>"
labels: ["qa", "smoke-test"]
assignees: []
---

> Run the full test plan from [extension/docs/QA/SMOKE_TEST_v1_1_0.md](../blob/main/extension/docs/QA/SMOKE_TEST_v1_1_0.md). Tick boxes here as you go.
>
> Replace the placeholders in the title with your initials and the date (e.g. `v1.1.0 QA: smoke test — AD 2026-05-22`).

## Environment

- VS Code version: _e.g. 1.96.2_
- macOS version: _e.g. 14.5 (Sonoma)_
- Installation method: _Marketplace / VSIX_
- FileMaker Server tested: _e.g. fm.example.com — FMS 21.0_
- Test account has `fmrest` privilege: _Yes / No_

## Core scenarios (release blockers)

- [ ] **SC-01** Install from Marketplace
- [ ] **SC-02** First-run Getting Started walkthrough auto-opens
- [ ] **SC-03** Activity bar icon visible
- [ ] **SC-04** Welcome view shows when no profiles exist
- [ ] **SC-05** Add Connection Profile wizard opens with focus + correct sections
- [ ] **SC-06** Wizard form responds to input + mode toggle
- [ ] **SC-07** Test Connection — failure path (bogus server)
- [ ] **SC-08** Test Connection — success path (real server)
- [ ] **SC-09** Save profile + persistent status bar item appears
- [ ] **SC-10** Status bar survives Reload Window
- [ ] **SC-11** Run Find (JSON) via command palette returns data
- [ ] **SC-12** Query Builder webview round-trips a query
- [ ] **SC-13** Error toast surfaces Retry / Edit Profile / Open Settings / Show Details
- [ ] **SC-14** Disconnect updates the status bar

## Secondary scenarios (regression coverage)

- [ ] **SC-15** Accessibility — aria-required, aria-describedby, visible `*`
- [ ] **SC-16** Command palette gating — no profile-required commands when zero profiles
- [ ] **SC-17** Untrusted workspace banner shows; write commands restricted
- [ ] **SC-18** Walkthrough screenshots load (no broken images)
- [ ] **SC-19** Deprecated `filemakerDataApiTools.*` settings honored with one-time toast
- [ ] **SC-20** Uninstall removes all UI surfaces

## Result

- [ ] **PASS** — all core scenarios green
- [ ] **FAIL** — at least one core scenario red (open follow-up issues + link below)

## Failures / notes

<details>
<summary>Attach screenshots, paste Output panel logs, Dev Tools console output, etc.</summary>

_Paste here._

</details>

## Follow-up issues opened from this pass

- (list issue links)
