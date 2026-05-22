# FileMaker Data API Tools — User Guide

## What You Need Before Starting

- **FileMaker Server** with the Data API enabled (Server Admin Console > Connectors > FileMaker Data API)
- A **FileMaker account** with the `fmrest` extended privilege enabled
- Your server must be reachable via **HTTPS** from your machine
- **VS Code** installed

See [Compatibility](./COMPATIBILITY.md) for FileMaker Server and FileMaker Cloud support notes, including Data API path, container field, value list, script, and OAuth caveats.

## Installing the Extension

1. Download `filemaker-data-api-tools-1.0.0.vsix` from [GitHub Releases](https://github.com/deffenda/filemaker-data-api-for-vs-code/releases).
2. Open VS Code.
3. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux) to open the Command Palette.
4. Type **Extensions: Install from VSIX...** and select it.
5. Browse to the downloaded `.vsix` file and select it.
6. Click **Reload** when prompted.

After reload, you should see a **FileMaker Explorer** panel in the sidebar (left side, look for the database icon).

---

## Setting Up a Connection

Adding a profile opens the **Connection Profile** wizard as a webview editor tab. All fields are visible at once — fill them in, click **Test Connection** to verify, then **Save Profile**. There's also a `🟢 / 🔴 / 🟡` badge next to the buttons that tracks whether the current values have been successfully tested.

To open the wizard:

1. Press `Cmd+Shift+P` / `Ctrl+Shift+P`.
2. Run **FileMaker: Add Connection Profile**.

The wizard has three sections — **Profile**, **Server**, and either **Credentials** (Direct mode) or **Proxy Settings** (Proxy mode). The mode toggle lives between the Profile and Server sections.

### Direct Mode (Connect to FileMaker Server Directly)

Use this when your machine can reach the FileMaker Server directly over HTTPS.

In the wizard, click **Direct** (selected by default) and fill in:

| Field | What to Enter | Example |
|-------|--------------|---------|
| Profile Name | A friendly name for this connection | `Production Server` |
| Server URL | Your FileMaker Server's HTTPS address | `https://fm.yourcompany.com` |
| Database Name | The hosted database file name | `Contacts` |
| API Base Path | Leave the default unless your server uses a custom path | `/fmi/data` |
| API Version | Leave the default | `vLatest` |
| Username | The FileMaker account with `fmrest` extended privilege | `api_user` |
| Password | The password for that account (hidden as you type) | — |

Then click **Test Connection** — the extension opens a session against your server and closes it cleanly. The badge turns green on success, red with the error message on failure. Once green, click **Save Profile**. The password is stored in VS Code's SecretStorage (platform-level encryption) and never written to settings files or logs.

### Proxy Mode (Connect Through a Middleware Proxy)

Use this when your team has a proxy/middleware layer in front of FileMaker, or when you can't connect to FileMaker Server directly.

In the wizard, click **Proxy** and fill in:

| Field | What to Enter | Example |
|-------|--------------|---------|
| Profile Name | A friendly name | `Team Proxy` |
| Server URL | The FileMaker Server URL your proxy talks to | `https://fm.yourcompany.com` |
| Database Name | The hosted database | `Contacts` |
| API Base Path | Leave the default | `/fmi/data` |
| API Version | Leave the default | `vLatest` |
| Proxy Endpoint | Your proxy's URL | `https://api.yourcompany.com/fm` |
| API Key (optional) | Bearer token your proxy expects | — |

Click **Test Connection**, then **Save Profile** once the badge is green.

### Editing or Re-Testing a Saved Profile

Run **FileMaker: Edit Connection Profile** (or right-click a profile in the FileMaker Explorer). The wizard reopens pre-populated with the saved values. Passwords aren't echoed back — leave the password field blank to keep the stored one, or enter a new value to replace it. After edits, the badge flips to 🟡 ("Edits since last test") until you re-test.

> **Test-before-save policy.** The setting `filemaker.connectionWizard.requireTestBeforeSave` controls how strictly the wizard enforces testing before saving:
>
> - `off` — no badge, save freely
> - `warn` (default) — show a confirmation dialog if you save without a green test
> - `block` — refuse to save until a green test is recorded on the current values

---

## Connecting to Your Server

After creating a profile:

1. Press `Cmd+Shift+P` / `Ctrl+Shift+P`.
2. Type **FileMaker: Connect** and select it.
3. If you have multiple profiles, select the one you want to connect to.
4. You'll see *"Connected to..."* in the notification area.
5. The **FileMaker Explorer** in the sidebar will populate with your database's layouts.

To disconnect later: **FileMaker: Disconnect**.

---

## Browsing Your Database

Once connected, the **FileMaker Explorer** sidebar shows:

```
FileMaker Explorer
├── Environment Sets
├── Jobs
└── Your Profile Name
    ├── Layout 1
    │   ├── Fields
    │   │   ├── FirstName (text)
    │   │   ├── LastName (text)
    │   │   └── Email (text)
    │   ├── Value Lists
    │   └── Schema Snapshots
    ├── Layout 2
    │   └── ...
    └── Saved Queries
```

Click on any layout to expand it and see its fields, value lists, and schema snapshots.

---

## Running Your First Query

1. Press `Cmd+Shift+P` / `Ctrl+Shift+P`.
2. Type **FileMaker: Open Query Builder** and select it.
3. A new panel opens with:
   - **Profile** dropdown (already set if connected)
   - **Layout** dropdown (select the layout to query)
   - **Find JSON** editor
   - **Sort**, **Limit**, **Offset** fields
4. Enter your find criteria in the JSON editor. Examples:

**Find all records:**
```json
[{}]
```

**Find by field value:**
```json
[{ "Status": "Active" }]
```

**Find with multiple criteria (AND):**
```json
[{ "Status": "Active", "City": "Portland" }]
```

**Find with multiple requests (OR):**
```json
[{ "City": "Portland" }, { "City": "Seattle" }]
```

**Find with omit (exclude):**
```json
[{ "City": "Portland" }, { "Status": "Inactive", "omit": "true" }]
```

5. Click **Run Find**.
6. Results appear in a table below. From here you can:
   - Click a column header to sort
   - Click **Export JSON** to open results in a new editor tab
   - Click **Export CSV** to save as a CSV file

---

## Viewing a Record

1. Press `Cmd+Shift+P` / `Ctrl+Shift+P`.
2. Type **FileMaker: Get Record by ID** and select it.
3. Select a profile and layout.
4. Enter the record ID.
5. The Record Viewer panel opens showing all field data and any related portal data.

---

## Editing a Record

1. Press `Cmd+Shift+P` / `Ctrl+Shift+P`.
2. Type **FileMaker: Open Record Editor** and select it.
3. Select a profile, layout, and optionally a record ID.
4. The Record Editor panel opens with editable fields.
5. Make your changes.
6. Click **Validate** to check for errors.
7. Click **Preview Update JSON** to see the exact patch that will be sent.
8. Click **Save** — you'll see a confirmation dialog showing which fields will change.
9. Confirm to save. The record is updated via the Data API.

---

## Creating a Record

1. Press `Cmd+Shift+P` / `Ctrl+Shift+P`.
2. Type **FileMaker: Create Record** and select it.
3. Select a profile and layout.
4. The Record Editor opens in **create mode** with empty fields.
5. Fill in the fields you want to set.
6. Click **Save** — you'll see a confirmation dialog.
7. On success, you'll see the new record ID.

---

## Deleting a Record

1. Press `Cmd+Shift+P` / `Ctrl+Shift+P`.
2. Type **FileMaker: Delete Record** and select it.
3. Select a profile and layout.
4. Enter the record ID to delete.
5. Confirm the deletion in the warning dialog.

**Note:** Delete is blocked if you're in viewer role or in an untrusted workspace.

---

## Running Scripts

1. Press `Cmd+Shift+P` / `Ctrl+Shift+P`.
2. Type **FileMaker: Open Script Runner** and select it.
3. Select a profile.
4. Choose a script from the dropdown (or type the name).
5. Optionally enter a script parameter.
6. Click **Run**.
7. The result is displayed below, and you can copy it as curl or fetch.

---

## Saving and Reusing Queries

After running a query in the Query Builder:

1. Press `Cmd+Shift+P` / `Ctrl+Shift+P`.
2. Type **FileMaker: Save Current Query** and select it.
3. Enter a name for the saved query.
4. The query appears in the **Saved Queries** section under your profile in the Explorer.

To run a saved query later: right-click it in the Explorer, or use **FileMaker: Run Saved Query**.

---

## Schema Snapshots and Diffing

Track schema changes over time:

1. **Capture a snapshot:** Right-click a layout in the Explorer > **Capture Schema Snapshot**, or use the Command Palette.
2. **Diff two snapshots:** Use **FileMaker: Diff Schema Snapshots** and select two snapshots to compare.
3. The Schema Diff panel shows added, removed, and changed fields side by side.

---

## Batch Operations

### Export

1. Use **FileMaker: Batch Export (Find)**.
2. Select profile, layout, and enter find criteria.
3. Choose output format (JSONL or CSV) and file location.
4. The export runs with a progress bar. Large exports are paginated automatically.

### Update

1. Use **FileMaker: Batch Update from File**.
2. Select a CSV or JSON file with `recordId` column and field columns.
3. The update runs in **dry-run mode** by default — review the preview before committing.

---

## Offline Mode

When you can't reach the server:

1. Use **FileMaker: Toggle Offline Mode**.
2. The Explorer shows an **OFFLINE MODE** badge.
3. You can still browse cached layout metadata, fields, and snapshots.
4. Write operations (edit, create, delete, batch update) are disabled.
5. Toggle offline mode off when you're back online.

---

## Multiple Profiles

You can create multiple connection profiles (e.g., Dev, Staging, Production):

- Use **FileMaker: Add Connection Profile** for each server.
- Switch between them with **FileMaker: Connect**.
- Only one profile is active at a time.
- Use **Environment Sets** to group profiles and compare layouts across servers.

---

## Keyboard Shortcuts

All commands are available from the Command Palette. Type `FileMaker` to see the full list. There are no default keyboard shortcuts — you can bind any command to a shortcut in VS Code's keyboard settings.

---

## Troubleshooting

| Problem | Solution |
|---------|---------|
| "Connection refused" or timeout | Verify the server URL is correct and reachable. Check your firewall/VPN. |
| HTTP 401 | Reconnect and re-enter your password. Verify the account has `fmrest` privilege. |
| HTTP 403 | Check that the account has access to the specific layouts and scripts. |
| HTTP 404 on metadata | Some servers don't expose metadata endpoints. Use the manual field entry flow. |
| Layouts not showing | Click refresh in the Explorer, or run **FileMaker: Refresh Schema Cache**. |
| Features disabled | You may be in an untrusted workspace. Trust the workspace via VS Code's trust dialog. |
| Extension not visible | Check that the VSIX installed correctly. Look for "FileMaker Data API Tools" in the Extensions panel. |

---

## Settings Reference

Open VS Code Settings (`Cmd+,` / `Ctrl+,`) and search for "filemaker" to see all available settings.

| Setting | Default | Description |
|---------|---------|------------|
| `filemakerDataApiTools.requestTimeoutMs` | 15000 | HTTP request timeout in milliseconds |
| `filemaker.logging.level` | info | Log level: debug, info, warn, error |
| `filemaker.savedQueries.scope` | workspace | Where saved queries are stored |
| `filemaker.schema.cacheTtlSeconds` | 300 | How long to cache layout metadata |
| `filemaker.batch.maxRecords` | 10000 | Maximum records for batch export |
| `filemaker.batch.concurrency` | 5 | Parallel requests during batch operations |
| `filemaker.enterprise.mode` | false | Enable enterprise role-based controls |
| `filemaker.offline.mode` | false | Enable offline metadata mode |
