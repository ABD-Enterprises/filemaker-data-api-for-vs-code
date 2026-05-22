# v1.1.0 Smoke Test — First-Time User Walkthrough

A manual test pass that exercises the extension end-to-end from a fresh install on a clean macOS machine. Designed to be run by a tester following the steps top-to-bottom; each scenario has a binary **PASS / FAIL** outcome.

> 🎯 **Goal:** confirm a user who has never seen this extension can install it, configure a connection, run a query, and recover from common errors — without reading the source.

If you're running this for a release, copy this whole file into a new GitHub issue using the **QA: Smoke test** template (see [.github/ISSUE_TEMPLATE/qa-smoke-test.md](../../../.github/ISSUE_TEMPLATE/qa-smoke-test.md)) so you have checkboxes that persist.

---

## Prerequisites

Before you start, gather:

- [ ] A **clean macOS machine** (or a fresh VS Code profile — see "Resetting your environment" below).
- [ ] **VS Code 1.96+** installed. Check via `Code → About Visual Studio Code`.
- [ ] A **FileMaker Server you can reach** (HTTPS, port 443 typically). Required for the Test Connection / Connect / Run Find scenarios. You can substitute a known-bogus URL for failure-path tests.
- [ ] A **FileMaker account** with the **`fmrest` extended privilege** enabled on at least one hosted database. Without this, login will return HTTP 401.
- [ ] A **terminal** with `git` and `code` CLI shortcuts. Run `code --version` to confirm.
- [ ] **~30 minutes** for a full pass.

### Resetting your environment (optional)

If you don't have a clean machine, isolate this test from your normal VS Code state:

```bash
# Use a sandbox profile so existing extensions/settings don't interfere.
code --user-data-dir /tmp/vscode-qa-v1.1.0 --extensions-dir /tmp/vscode-qa-v1.1.0-ext
```

Every subsequent `code` command in this doc should include those flags. Or set an alias:

```bash
alias code-qa='code --user-data-dir /tmp/vscode-qa-v1.1.0 --extensions-dir /tmp/vscode-qa-v1.1.0-ext'
```

---

## What you're testing

This release (v1.1.0) hardened the first-time-user experience. The scenarios below directly cover the changes in the [CHANGELOG](../../CHANGELOG.md#110):

| Area | Scenarios |
|---|---|
| Onboarding (walkthrough, welcome view, activity bar icon) | SC-02, SC-03, SC-04 |
| Connection wizard (the v1.0.0 wizard had a load bug) | SC-05, SC-06, SC-07, SC-08 |
| Connection persistence (status bar item) | SC-09, SC-10, SC-14 |
| Querying (palette + webview) | SC-11, SC-12 |
| Error recovery (Retry / Edit / Settings actions) | SC-13 |
| Accessibility | SC-15 |
| Discoverability (palette gating, untrusted workspace) | SC-16, SC-17 |

---

# Scenarios

Each scenario follows the same shape:

> **Precondition** — what state the system should be in before you start.
> **Steps** — numbered actions to take.
> **Expected** — what you should observe at each step.
> **Pass criteria** — binary "everything in Expected happened? PASS, otherwise FAIL".
> **On failure** — what to capture so we can debug.

---

## SC-01: Install from the Marketplace

**Precondition:** Clean VS Code, no FileMaker extension installed.

**Steps:**
1. Open VS Code.
2. Press `⌘+Shift+X` (Extensions view).
3. Search for `FileMaker Data API`.
4. Click **Install** on the entry by **deffenda**.

**Expected:**
- The extension installs without errors.
- The Extensions sidebar shows the entry as "Installed" and lists version **1.1.0**.
- A toast may appear briefly; no red error toasts.

**Pass criteria:** Installed, version 1.1.0, no errors.

**On failure:** Screenshot the Extensions view + open `Help → Toggle Developer Tools → Console` and screenshot any errors.

---

## SC-01b: Install from VSIX (alternative path)

Skip this scenario if SC-01 passed. Use it if Marketplace install is unavailable or you want to test a pre-release VSIX.

**Precondition:** Clean VS Code.

**Steps:**
1. Download the VSIX from https://github.com/deffenda/filemaker-data-api-for-vs-code/releases/download/v1.1.0/filemaker-data-api-tools-1.1.0.vsix
2. In a terminal: `code --install-extension ~/Downloads/filemaker-data-api-tools-1.1.0.vsix`
3. Restart VS Code.

**Expected:**
- Terminal prints `Extension 'filemaker-data-api-tools-1.1.0.vsix' was successfully installed.`
- Extensions view shows the installed entry, version 1.1.0.

**Pass criteria:** Installed, version 1.1.0.

**On failure:** Save the terminal output. The VSIX is signed/published by `deffenda`; if VS Code rejects unverified extensions, change `extensions.verifySignature` to `false` temporarily.

---

## SC-02: First-run Getting Started walkthrough auto-opens

**Precondition:** Extension freshly installed, never opened before.

**Steps:**
1. Reload VS Code (`⌘+Shift+P` → **Developer: Reload Window**).
2. Wait ~2 seconds after the editor finishes loading.

**Expected:**
- The **Getting Started with FileMaker Data API Tools** walkthrough opens automatically in an editor tab.
- The walkthrough has at least 3 numbered steps: Add a profile / Test & connect / Query Builder.
- Each step has a markdown body and at least one screenshot image.
- Clicking a step expands its content; clicking the "Mark Done" button checks it off.

**Pass criteria:** Walkthrough opened automatically, has 3+ steps, screenshots load.

**On failure:** Screenshot the editor. If the walkthrough did not open: run `⌘+Shift+P` → **FileMaker: Open Getting Started Walkthrough** and capture what opens (or doesn't). Check `Help → Toggle Developer Tools → Console` for errors.

---

## SC-03: Activity bar icon visible

**Precondition:** Extension installed.

**Steps:**
1. Look at the leftmost vertical strip of icons (the Activity Bar).
2. Scroll the icons if necessary — the FileMaker icon may be at the bottom.

**Expected:**
- An icon labeled **FileMaker Data API** (or just **FileMaker**) is present.
- Hovering shows the tooltip.
- Clicking it opens the FileMaker sidebar.

**Pass criteria:** Icon present + tooltip + sidebar opens.

**On failure:** Screenshot the activity bar. Right-click on the activity bar → confirm the FileMaker entry exists in the visibility list.

---

## SC-04: Welcome view shows when no profiles exist

**Precondition:** No FileMaker connection profiles configured. (If you've used the extension before, run `⌘+Shift+P` → **FileMaker: Manage Profiles** → delete all to reach this state.)

**Steps:**
1. Click the FileMaker icon in the activity bar (from SC-03).
2. Look at the sidebar content.

**Expected:**
- The sidebar shows a Welcome view with at minimum:
  - A heading or message indicating no profiles exist.
  - An **Add Connection Profile** button.
  - An **Open Walkthrough** link.
- The sidebar does NOT show empty "Environment Sets" or "Jobs" tree nodes (those should be hidden until they have content).

**Pass criteria:** Welcome view rendered with the Add Connection Profile affordance.

**On failure:** Screenshot the sidebar. This is one of the v1.1.0 fixes — if the empty view is missing, regression alert. Note any unexpected tree nodes.

---

## SC-05: Open Add Connection Profile wizard

**Precondition:** SC-04 passed (welcome view visible).

**Steps:**
1. Click the **Add Connection Profile** button in the Welcome view.
   - Alternatively: `⌘+Shift+P` → **FileMaker: Add Connection Profile**.

**Expected:**
- A new editor tab opens titled **Add Connection Profile**.
- The form has these visible sections:
  - **Profile** (one text field: Profile Name).
  - **Authentication Mode** with two pill buttons: **Direct** (selected by default) and **Proxy**.
  - **Server** with two visible fields: Server URL, Database Name.
  - An **Advanced server options** collapsed `<details>` disclosure (click to expand reveals API Base Path + API Version).
  - **Credentials** section with Username + Password inputs.
- Focus lands on the first input (Profile Name) on open.
- Tabbing through inputs follows top-to-bottom order without skipping.

**Pass criteria:** Wizard opened, form sections present, advanced fields hidden by default, initial focus correct.

**On failure:** **This is a critical regression** if the form doesn't render or buttons don't respond — the v1.1.0 wizard fix is exactly this. Capture: a screenshot, and the Developer Tools console (`Help → Toggle Developer Tools` → Console tab) for any `TypeError: Cannot read properties of null` errors.

---

## SC-06: Wizard form responds to input

**Precondition:** Wizard open from SC-05.

**Steps:**
1. Type a name into Profile Name, e.g. `qa-smoke-v1.1.0`.
2. Click **Proxy** to toggle modes. Click **Direct** again to switch back.
3. Type any URL into Server URL.
4. Click anywhere outside the inputs.

**Expected:**
- Each keystroke appears in the field in real time.
- Mode toggle visibly highlights the selected button (`aria-pressed="true"`), and the Credentials/Proxy Settings sections swap.
- Required fields without values show no validation error UNTIL you click Save (validation is on submit, not on blur).
- The **Test Connection** badge (right of the buttons) shows ⚪ "Connection not tested" while inputs are empty/changing.

**Pass criteria:** All input/toggle interactions register.

**On failure:** If keystrokes don't register or the mode toggle does nothing: capture Developer Tools console. This was the v1.0.0 wizard bug.

---

## SC-07: Test Connection — failure path

**Precondition:** Wizard open with all required fields filled BUT pointing at a known-bogus server (e.g. `https://no-such-host.invalid`).

**Steps:**
1. Profile Name: `qa-fail-test`.
2. Server URL: `https://no-such-host.invalid`.
3. Database: `nothing`.
4. Username: `nobody`. Password: leave blank.
5. Click **Test Connection**.

**Expected:**
- The button label changes to "Testing..." and becomes disabled.
- Within ~30 seconds, a status message appears below the buttons indicating connection failure.
- The badge shows 🔴 "Test failed: …" with an error summary.
- A toast (or inline panel) offers a **Show Details** action OR an inline error message. Clicking Show Details (if present) opens a markdown buffer with redacted request chain + a **Copy as Bug Report** option.
- Button returns to "Test Connection" and re-enables.

**Pass criteria:** Failure surfaces clearly, button re-enables, no UI freeze.

**On failure:** Capture: badge state, status text, any toasts. If the wizard hangs with "Testing..." indefinitely, **regression** — the timeout policy is not engaging.

---

## SC-08: Test Connection — success path

**Precondition:** Wizard open. You have a real FileMaker Server, database, and `fmrest`-enabled account.

**Steps:**
1. Replace the bogus values from SC-07 with your real server details.
2. Click **Test Connection**.

**Expected:**
- Button label changes to "Testing...".
- Within ~10 seconds, the badge turns 🟢 "Test passed".
- A success status message appears below the buttons.
- Button returns to "Test Connection" and re-enables.

**Pass criteria:** Badge turns green, no errors.

**On failure:** Capture badge state + Output panel (`View → Output → FileMaker Data API Tools`). If you get 401, your account doesn't have `fmrest` privilege — fix the FM account then retry. If 404, check Server URL + Database name.

---

## SC-09: Save profile + persistent status bar

**Precondition:** SC-08 passed (green badge).

**Steps:**
1. Click **Save Profile** in the wizard.
2. Observe the bottom status bar of VS Code.
3. Run `⌘+Shift+P` → **FileMaker: Connect**. Pick your profile from the list.

**Expected:**
- Save: a success toast appears: `Profile "<name>" saved. Use FileMaker: Connect to start a session.`
- After **Connect**: the bottom status bar shows a persistent indicator like `$(plug) FileMaker: <profile name>`.
- The status bar item is **always visible** (not just briefly shown then dismissed).

**Pass criteria:** Save succeeded, persistent status bar item appears and stays.

**On failure:** Capture: status bar screenshot, Output panel.

---

## SC-10: Status bar survives reload

**Precondition:** SC-09 passed (you are connected).

**Steps:**
1. Reload VS Code (`⌘+Shift+P` → **Developer: Reload Window**).
2. Wait for the editor to finish loading.
3. Look at the status bar.

**Expected:**
- After reload, the status bar shows the same `$(plug) FileMaker: <profile name>` (the session may have re-authenticated automatically OR show "not connected" if the session expired — both are acceptable as long as the indicator is **present**).

**Pass criteria:** Status bar item is present after reload.

**On failure:** Capture status bar + Output panel. Note whether the wizard or any toast appears.

---

## SC-11: Run Find via the command palette

**Precondition:** Connected (SC-09 / SC-10).

**Steps:**
1. `⌘+Shift+P` → **FileMaker: Run Find (JSON)**.
2. The first input prompt asks for "Find JSON". Type/paste a real find for a layout you have access to, e.g. `[{"RecordID":">0"}]`. Press Enter.
3. The next prompts: layout name (type a real layout), optional sort (skip with Enter), optional limit (e.g. `5`), optional offset (Enter to skip).

**Expected:**
- After the final prompt, a new editor tab opens with the JSON response.
- The response contains a `data` array with up to 5 records.
- No error toast.

**Pass criteria:** Query returned data and rendered in a buffer.

**On failure:** Capture: the input prompts (which step failed?), the resulting error toast, Output panel. If the prompts feel confusing (no progress indicator), that's a known papercut — not a fail unless the prompts also misbehave.

---

## SC-12: Open the Query Builder webview

**Precondition:** Connected.

**Steps:**
1. `⌘+Shift+P` → **FileMaker: Open Query Builder**.

**Expected:**
- A new editor tab opens with a structured form: profile selector, layout selector, find conditions, sort, limit, offset, Run button.
- The profile selector is pre-populated and focused on open.
- Selecting a layout populates a field reference chip strip.
- Clicking Run executes the query and shows results inline.

**Pass criteria:** Webview renders, focus correct, query round-trip works.

**On failure:** Capture: webview screenshot, Developer Tools console for the webview (right-click → Inspect Element → Console).

---

## SC-13: Error toast actions (Retry / Edit Profile / Open Settings)

**Precondition:** You have at least one profile saved. You can either:
(a) Edit your saved profile to use a bogus URL, then retry Connect, OR
(b) Disconnect from your real server then unplug your network adapter and try Connect.

**Steps:**
1. Trigger a connection failure (one of the above).
2. Look at the error toast that appears.

**Expected:**
- The toast offers buttons inline: **Retry**, **Edit Profile**, **Open Settings**, **Show Details**.
- Clicking **Edit Profile** reopens the wizard for the failing profile.
- Clicking **Open Settings** jumps to `filemaker.requestTimeoutMs` (or another relevant setting) in the Settings UI.
- Clicking **Retry** re-invokes Connect.
- Clicking **Show Details** opens a markdown buffer with a redacted request chain and a "Copy as Bug Report" action.

**Pass criteria:** All four actions present and functional.

**On failure:** Capture the toast. If actions are missing this is a v1.1.0 regression (#92).

---

## SC-14: Disconnect

**Precondition:** Connected.

**Steps:**
1. `⌘+Shift+P` → **FileMaker: Disconnect**.

**Expected:**
- A toast confirms disconnect.
- The status bar updates from `$(plug) FileMaker: <profile>` to either `$(circle-outline) FileMaker: Not connected` or removes the item entirely.

**Pass criteria:** Status reflects disconnected state.

**On failure:** Capture status bar.

---

# Secondary scenarios (regression coverage)

Run these if SC-01 through SC-14 all pass. They cover less-critical paths.

## SC-15: Accessibility — required field markers

**Steps:**
1. Open the wizard (`⌘+Shift+P` → **FileMaker: Add Connection Profile**).
2. Use the Tab key (no mouse) to navigate the form.
3. Inspect a required field (right-click → Inspect Element) and look for `aria-required="true"`.

**Expected:**
- Required fields have a visible `*` after the label.
- Inputs have `aria-required="true"` attribute.
- Hints are linked via `aria-describedby` (the input's `aria-describedby` attribute points to the hint's `id`).
- Tab order is logical top-to-bottom.

**Pass criteria:** All four observable.

---

## SC-16: Command palette gating

**Precondition:** A clean install with **no profiles** configured.

**Steps:**
1. `⌘+Shift+P`, type `filemaker`.
2. Count the FileMaker commands shown.

**Expected:**
- The palette shows **only** the commands relevant to "no profiles yet" state — primarily **FileMaker: Add Connection Profile**, **FileMaker: Open Getting Started Walkthrough**, **FileMaker: Open User Guide**, and a handful of advanced/diagnostic entries.
- Commands that require an active connection (e.g. **Run Find**, **Open Query Builder**, schema commands) should be **hidden** until at least one profile exists.

**Pass criteria:** Palette shows ~5–10 commands, not 40+.

---

## SC-17: Untrusted workspace banner

**Steps:**
1. Open a folder that VS Code has not yet marked as trusted (e.g. clone a random repo to a new path and open it).
2. Click the FileMaker icon in the activity bar.

**Expected:**
- VS Code's built-in "Restricted Mode" banner appears at the top of the editor.
- The FileMaker sidebar still works for read-only operations (browse profiles, view schema snapshots) but write commands (Edit Record, Batch Update, Generate TypeScript Types) either don't appear in the palette or show a clear restricted-mode message.

**Pass criteria:** Banner present, write commands restricted.

---

## SC-18: Walkthrough screenshots load

**Steps:**
1. `⌘+Shift+P` → **FileMaker: Open Getting Started Walkthrough**.
2. Click through each step.

**Expected:**
- Every step shows its body text AND at least one screenshot/image.
- No broken-image placeholders.

**Pass criteria:** All images render.

---

## SC-19: Settings — deprecated keys honored with toast

**Precondition:** Have `filemakerDataApiTools.logLevel` set to `debug` in your settings.json (the legacy namespace).

**Steps:**
1. Open Settings (`⌘+,`).
2. Edit settings.json directly. Add:
   ```json
   "filemakerDataApiTools.logLevel": "debug"
   ```
3. Reload VS Code.

**Expected:**
- A one-time toast appears: `Setting "filemakerDataApiTools.logLevel" is deprecated. Use "filemaker.logging.level" instead.` with an "Open Settings" action.
- The extension still honors the legacy key (Output channel logs at debug level).

**Pass criteria:** Toast appeared AND legacy value honored.

---

## SC-20: Uninstall — clean state

**Steps:**
1. Extensions view → click the gear on the FileMaker entry → **Uninstall**.
2. Reload.
3. Open the Command Palette and search `filemaker`.

**Expected:**
- No FileMaker commands appear.
- The activity bar no longer has the FileMaker icon.
- No leftover status bar items.

**Pass criteria:** All UI surfaces removed.

**Note:** Saved profiles and SecretStorage entries are not removed by uninstall (this is VS Code policy). Reinstalling restores everything.

---

# Test result template

Copy this section into the issue or local notes:

```
## v1.1.0 Smoke Test Result — <date> — <tester>

VS Code version: <e.g. 1.96.2>
macOS version: <e.g. 14.5>
FileMaker Server tested against: <e.g. fm.example.com / FMS 21.0>

### Core
- [ ] SC-01 Install from Marketplace
- [ ] SC-02 Walkthrough auto-opens
- [ ] SC-03 Activity bar icon visible
- [ ] SC-04 Welcome view (empty state)
- [ ] SC-05 Wizard opens
- [ ] SC-06 Wizard input responds
- [ ] SC-07 Test Connection — failure path
- [ ] SC-08 Test Connection — success path
- [ ] SC-09 Save + persistent status bar
- [ ] SC-10 Status bar survives reload
- [ ] SC-11 Run Find (palette)
- [ ] SC-12 Query Builder webview
- [ ] SC-13 Error toast actions
- [ ] SC-14 Disconnect

### Secondary
- [ ] SC-15 a11y markers
- [ ] SC-16 Palette gating
- [ ] SC-17 Untrusted workspace
- [ ] SC-18 Walkthrough screenshots
- [ ] SC-19 Deprecated settings
- [ ] SC-20 Uninstall

### Failures / notes
<paste screenshots, copy/paste Output panel logs, etc>
```

---

# Reporting bugs found during this pass

If any scenario fails:

1. Capture: VS Code version, macOS version, the failing screenshot, and the relevant Output panel logs (`View → Output → FileMaker Data API Tools` dropdown).
2. If a webview is involved, also capture Developer Tools console (`Help → Toggle Developer Tools`).
3. Open a new issue at https://github.com/deffenda/filemaker-data-api-for-vs-code/issues with a title like `v1.1.0 QA: SC-XX <short failure description>`. Attach the smoke test issue link.
