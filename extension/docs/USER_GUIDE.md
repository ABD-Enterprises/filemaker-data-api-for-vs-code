# FileMaker Data API Tools: User Guide

This is the manual for operators and developers who use the extension to work with a FileMaker database from VS Code. It covers the version in this repository (1.4). You can open it from VS Code with **FileMaker: Open User Guide**.

Command names below are the titles you see in the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows and Linux). Every command starts with `FileMaker:`.

## Contents

1. [First run in 10 minutes](#first-run-in-10-minutes)
2. [Before you start](#before-you-start)
3. [What's new in 1.4](#whats-new-in-14)
4. [Install](#install)
5. [Connect to a server](#connect-to-a-server)
6. [The FileMaker sidebar](#the-filemaker-sidebar)
7. [Find records: Query Builder](#find-records-query-builder)
8. [View, edit, create and delete records](#view-edit-create-and-delete-records)
9. [Upload to a container field](#upload-to-a-container-field)
10. [Batch export and batch update](#batch-export-and-batch-update)
11. [Run scripts](#run-scripts)
12. [Schema snapshots and diffs](#schema-snapshots-and-diffs)
13. [Generate types, a client and snippets](#generate-types-a-client-and-snippets)
14. [FM Web and Layout Mode](#fm-web-and-layout-mode)
15. [Offline mode](#offline-mode)
16. [Enterprise mode and roles](#enterprise-mode-and-roles)
17. [Plugins](#plugins)
18. [Using AI with FileMaker](#using-ai-with-filemaker)
19. [User settings vs Workspace settings in plain words](#user-settings-vs-workspace-settings-in-plain-words)
20. [Settings reference](#settings-reference)
21. [Security behavior you will notice](#security-behavior-you-will-notice)
22. [Troubleshooting](#troubleshooting)
23. [FAQ](#faq)

---

## First run in 10 minutes

This is the shortest path from nothing to a first query. Each step links to the detail.

1. **Install.** In VS Code open the Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`), search for **FileMaker Data API Tools** (publisher SureForgeTech) and select **Install**.
2. **Open a folder** (File > Open Folder...). Saved queries, schema snapshots, generated types and the offline cache are stored in the folder, so open one even if you only want to try a find. When VS Code asks whether you trust the authors of the folder, choose **Yes, I trust the authors** (see [Trusted workspace and Restricted Mode](#trusted-workspace-and-restricted-mode)).
3. **Check the server side.** You need the Data API enabled, an HTTPS address with a certificate your computer trusts, and an account whose privilege set has the `fmrest` extended privilege ([how](#before-you-start)).
4. **Create a profile.** Run **FileMaker: Add Connection Profile**. Choose **Direct**, enter a name, the server URL (`https://fm.example.com`), the database name (without `.fmp12`), the account and the password. Select **Test Connection**; when the badge is green select **Save Profile**.
5. **Connect.** Select **Connect Now** in the notification that appears after saving (or run **FileMaker: Connect**). The sidebar fills with layouts.
6. **Run your first find.** Right-click a layout and choose **Open Query Builder**, add a condition and select **Run**.

Something failed? Start with [Troubleshooting](#troubleshooting): the first row covers certificate errors, the most common first-run problem.

---

## Before you start

You need:

- A **FileMaker Server** (or FileMaker Cloud) with the **FileMaker Data API** enabled. On Server this is in the Admin Console under Connectors.
- A server address your computer can reach over **HTTPS**, with a **certificate your computer trusts**. If your server uses a certificate from a private authority or a self-signed one, the connection wizard has a **Certificates (advanced)** section for it (see [Certificates](#certificates-private-authority-or-self-signed)).
- A **FileMaker account** whose privilege set has the **`fmrest`** extended privilege (called "Access via FileMaker Data API"). To grant it, open the database in FileMaker Pro, choose File > Manage > Security, edit the account's privilege set, open **Extended Privileges**, and tick `fmrest`. Without it the sign-in fails and can look like a wrong password.
- **VS Code 1.96 or newer.**
- **A folder open in VS Code** for anything that is saved: saved queries, schema snapshots, type generation, the offline cache and the AI context copy.

See [Compatibility](./COMPATIBILITY.md) for server versions and caveats.

Use a dedicated account for this work, with only the access you need. A FileMaker privilege set is the one limit that holds no matter what the extension, an AI tool or you do.

### Trusted workspace and Restricted Mode

VS Code has a safety feature called Workspace Trust. When you open a folder you have not trusted, VS Code runs in **Restricted Mode** (a banner says so) and extensions must limit themselves. Choose **Yes, I trust the authors** in the banner or dialog when the folder is yours or comes from a source you trust. You can review it with **Workspaces: Manage Workspace Trust**.

In an untrusted workspace this extension can browse, read metadata and run finds. It will not edit, create or delete records, upload to containers, run scripts, write generated files, run batch jobs, load plugins, start the FM Web preview, or register AI tools, and it ignores a `.filemaker/profile-template.json`. Trust is checked each time, and a panel that is already open refuses changes if trust is lost. A trusted workspace is also not a free pass: the extension still asks before risky actions. See [Security behavior you will notice](#security-behavior-you-will-notice).

### Opening your user settings

Several settings (everything under `filemaker.ai.*` except `hiddenFields`) are read from your **user** settings only. To edit them, run **Preferences: Open User Settings (JSON)** from the Command Palette and add entries such as `"filemaker.ai.enabled": true`, or run **Preferences: Open Settings (UI)**, search for `filemaker`, and make sure the **User** tab is selected (not **Workspace**).

---

## What's new in 1.4

New:

- **Use AI with FileMaker, safely.** Off by default. **FileMaker: Write AI Context** writes a short description of your layouts, fields and script names for AI coding tools. AI tools in VS Code (agent mode) can list layouts, read records and, only if you allow it, change one record at a time or run scripts you approve. You approve every change. See [Using AI with FileMaker](#using-ai-with-filemaker).
- **Edit-conflict protection in the Record Editor.** If someone else changes a record after you opened it, your save is refused instead of overwriting their change. The editor shows which fields changed and keeps your edits. See [Edit a record](#edit-a-record).
- **Empty results are not errors.** A find that matches nothing now returns an empty result. Before, it showed an error, and a batch export could fail on its last request.
- **Create Record works.** The Record Editor's create mode lists the layout's fields, has a **Create Record** button with a confirmation, and shows the new record's ID.
- **Certificates in the wizard.** A **Certificates (advanced)** section accepts a custom CA file, or (insecure, per profile, confirmed once) a self-signed certificate. See [Certificates](#certificates-private-authority-or-self-signed).
- **One session renewal.** When a session expires while several requests run, they now share one renewal instead of each opening a new FileMaker session.

Changes you may notice (details in the [upgrade notes](../UPGRADE.md)):

- Editing, creating, deleting and uploading records and the Script Runner now need a trusted workspace, and **Delete Record** also needs record editing to be switched on.
- A repository can no longer loosen your policy. Enterprise mode, the role, offline mode and the `filemaker.features.*.enabled` switches from a workspace can only make things stricter.
- You are asked before the extension runs a workspace plugin, runs `npm install` for the FM Web preview, runs a Layout Mode script, or sends credentials to an address that came from the workspace or uses plain `http://`.
- The connection wizard asks you to enter the password again when you change the server address, proxy address or user name. **Test Connection** no longer touches the saved profile's secrets.
- CSV exports and **Copy results as table** put a leading apostrophe (`'`) in front of text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return, so a spreadsheet does not run it as a formula. `filemaker.export.neutralizeFormulas` (user settings) turns that off. A CSV export can be edited and imported back.
- The FM Web live preview is not in the Marketplace build; it needs the repository. Layout Mode is unchanged.
- Generated type files for layouts with spaces or punctuation in the name get a new file name (with a short hash). Delete the old files.
- Logs and error details hide more secrets (session tokens in URLs, more token-like keys, passwords in URLs).
- A status bar item `AI: off` is always shown, on the right. Selecting it switches AI tools off when they are on. When AI is not on, it only explains why (for example `filemaker.ai.enabled` is off, offline mode, an untrusted workspace, enterprise policy, or no connection enabled) and offers **Open AI Settings**; it does not change anything.

---

## Install

1. Open the Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`).
2. Search for **FileMaker Data API Tools** (publisher **SureForgeTech**) and select **Install**.

From a terminal: `code --install-extension SureForgeTech.filemaker-data-api-tools`.

To install a specific version from a file, download the `.vsix` from the [GitHub releases](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases), then run **Extensions: Install from VSIX...** in VS Code. A VSIX does not update itself. Check the version number on the release page: the Marketplace always has the newest build.

To check the install, open the Command Palette and type `FileMaker:`. Run **FileMaker: Open Getting Started Walkthrough** for a short guided tour.

---

## Connect to a server

A **connection profile** holds the server address, the database name and how you sign in. Profiles belong to your VS Code install and follow you between workspaces. Passwords never go into a settings file.

### Add a profile

1. Run **FileMaker: Add Connection Profile** (or select the plus icon in the FileMaker sidebar). The connection wizard opens in an editor tab.
2. Fill in **Profile**: a name such as `Dev Server`.
3. Choose **Direct** or **Proxy**:
   - **Direct**: the extension talks straight to the FileMaker Data API. Enter the server URL (for example `https://fm.example.com`), the database name (the file name without `.fmp12`), the account name and the password.
   - **Proxy**: your team runs a middleware service in front of FileMaker. Enter the server URL the proxy talks to, the database name, the proxy endpoint, and the proxy API key if it needs one. The extension never sees the FileMaker credentials in this mode.
4. Leave **API Base Path** (`/fmi/data`) and **API Version** (`vLatest`) alone unless your administrator says otherwise. They are under the advanced server options.
5. Select **Test Connection**. A badge shows the result: green for a successful test, red with the error message for a failure, yellow if you changed something since the last test.
6. Select **Save Profile**. A notification offers **Connect Now**; select it to open a session.

How strict the wizard is about testing is set by `filemaker.connectionWizard.requireTestBeforeSave`: `off`, `warn` (the default: asks you to confirm when you save an untested profile) or `block`.

### Where secrets go

The password, proxy API key and session token are stored in VS Code SecretStorage, which uses your operating system's keychain. They are not written to settings, profiles, saved queries, snapshots or logs. If SecretStorage is not available (for example a Linux machine without a keyring), connecting fails with an error. `filemaker.secrets.fallback` lets you choose a fallback in VS Code workspace storage (`workspace-state`) for headless setups. That fallback is **obfuscated, not protected**: the key is derived from the machine ID, so anyone who can read your VS Code state on this machine can recover the secrets. Use it only when there is no keyring. This setting is read from your user settings only (a workspace value is ignored). The default is `vscode-only`.

### What the wizard asks you to confirm

- **Plain `http://` to a remote server.** The password would travel unencrypted. You can continue, but you are warned.
- **An address that came from the workspace.** See profile templates below.
- **A changed server, proxy or user name.** When you edit a saved profile and change the server address, the proxy address or the account name, the wizard does not reuse the saved password or API key. Type it again. This stops a saved password from being sent to a different server. If you only change the profile name or the database, the saved secret is kept.
- **Test Connection** opens a throwaway session and closes it. It never changes the saved profile's secrets. For an unchanged server and user, leave the password empty to test with the saved one.

Server addresses with a user name or password inside them (`https://user:pass@host`) are rejected.

### Certificates (private authority or self-signed)

FileMaker Server often uses a certificate from a company authority or a self-signed one. The wizard's **Certificates (advanced)** section (under the server fields) has two ways to trust it, both stored per profile and both for `https://` addresses only:

- **Custom CA certificate file.** The absolute path to a PEM file with the certificate of the authority that signed your server's certificate. It is added to the certificates your computer already trusts (the built-in public list and, where VS Code can read it, your operating system's store), not substituted for them, so public servers keep working. If you renew or edit the file, the next connection uses the new content without restarting VS Code. This is the preferred option.
- **Trust this server's certificate (pinning).** When Test Connection (or a connection error) meets a certificate problem, **Trust this certificate…** shows who the certificate is for, its dates, its SHA-256 fingerprint and why it was refused. If you recognise the fingerprint (compare it with the one in the Admin Console, or ask the administrator) and accept, the extension trusts exactly that one certificate for this connection, nothing else. If the server later presents a different certificate, or this one expires, the connection is refused and you can choose **Review and re-trust**. You can also start the review yourself with **Review server certificate…**, and forget it with **Forget trusted certificate**.

Older profiles that had **Allow self-signed certificate** turned on keep working, but that setting skips every certificate check, so the profile list and the status bar show a warning and the extension offers once to convert it to a pinned certificate. Neither option can come from a profile template or any workspace file; you set them yourself in the wizard. The wizard's **Test Connection** shows which step failed: reaching the Data API, listing the hosted databases, or signing in.

### Profile templates for a team

A repository can include `.filemaker/profile-template.json` to pre-fill the wizard for everyone who clones it:

```json
{
  "name": "Team Development",
  "authMode": "direct",
  "serverUrl": "https://fm-dev.example.com",
  "database": "TeamApp",
  "apiBasePath": "/fmi/data",
  "apiVersionPath": "vLatest",
  "username": "developer",
  "locked": true
}
```

For a proxy profile use `"authMode": "proxy"` and `"proxyEndpoint"` instead of `"username"`. A template must not contain secrets: a `password`, `proxyApiKey`, token or any unsupported field makes the extension ignore the whole template and show a warning. Everyone enters their own password in the wizard.

`"locked": true` makes the database name, API base path and API version read-only in the wizard. The server address and proxy endpoint are never locked, so you can always see and change where your credentials go.

**Why a repository's template is not trusted:** it names the server your credentials will be sent to, and a cloned repository could name a server owned by someone else. So:

- In an **untrusted workspace** the template is ignored.
- In a trusted workspace the wizard names the address on a banner, and asks you to confirm before it saves or tests credentials against an address that came from the template. It does not ask if you already have a profile for that server.

### Connect, disconnect and switch

- **FileMaker: Connect** opens a session. If you have several profiles, you choose one. A transient failure (network error, server error) is retried with growing delays (`filemaker.connect.*` settings).
- **FileMaker: Disconnect** closes the session.
- The status bar item `FileMaker: <profile>` shows the active profile. Select it for **FileMaker: Show Connection Menu** (switch profile, disconnect).
- Data commands use the active profile, or your only profile, without asking. With no profile, they offer to add one.
- **FileMaker: Edit Connection Profile** and **FileMaker: Remove Connection Profile** (also on the profile's right-click menu) change or delete a profile. Removing a profile also deletes its saved queries and secrets.

Press `Escape` in any picker or input box to cancel the command.

### Sessions

FileMaker Data API tokens expire after about 15 minutes of inactivity. The extension renews the token about 30 seconds early (`filemaker.session.refreshLeadSeconds`) and treats a token as expired after 14 minutes (`filemaker.session.maxAgeMinutes`). If a request is still rejected as unauthorized, it signs in again once and retries, and reports an error only if that fails too.

---

## The FileMaker sidebar

The FileMaker icon in the activity bar opens two views.

**Connections** shows:

```
Connections
  Environment Sets          (only when you have created one)
  Jobs                      (while batch jobs exist)
  <Profile name>
    <Layout>
      Fields
      Value Lists
      Schema Snapshots
    Saved Queries
```

Right-click a layout for the common actions: open the Query Builder, open or edit a record, run a script, capture or diff a schema snapshot, generate types, batch export, batch update, upload to a container. Right-click a profile to connect, edit, remove or generate types for all layouts.

**Layout Inspector** shows the fields, portals, value lists and field validation rules of one layout. Select a layout in Connections, or run **FileMaker: Select Layout for Inspector**.

**FileMaker: Refresh Connections** reloads the tree. **FileMaker: Refresh Schema Cache** drops the cached layout metadata (kept for `filemaker.schema.cacheTtlSeconds`, default 300 seconds).

Some commands are hidden from the Command Palette until you need them:

- Most data commands appear after you have at least one profile.
- Environment Set commands appear only in [enterprise mode](#enterprise-mode-and-roles).
- Jobs, request history, the diagnostics dashboard, circuit breaker and plugin commands appear only when `filemaker.advanced.powerUserMode` is on.

---

## Find records: Query Builder

1. Run **FileMaker: Open Query Builder**, or right-click a layout and choose it.
2. Pick the **Profile** and the **Layout**.
3. On the **Form** tab, build the find: choose a field (field names autocomplete), a condition, and a value. Conditions include *matches*, *equals (whole field)*, *begins with*, *contains phrase*, *greater than*, *at least*, *less than*, *at most*, *between*, *is empty* and *is not empty*.
4. Select **Add request (OR)** for an alternative set of criteria. Tick **Omit** on a request to exclude its matches. Use **Add sort field** to sort.
5. Select **Run** (or press `Ctrl+Enter` / `Cmd+Enter`).

The **JSON** tab shows the same request as a Data API find body, and you can edit it directly. For example, `[{ "Status": "Active", "City": "Portland" }]` means Active AND Portland; `[{ "City": "Portland" }, { "City": "Seattle" }]` means Portland OR Seattle; a request with `"omit": "true"` excludes its matches.

Results:

- The table shows `Showing 1-100 of N found`. Use **Previous page** and **Next page**, and set **Records per page** and **Start at record** (the first record is 1).
- Select a column heading to sort the current page. Double-click a row, or use **View** or **Edit**, to open that record.
- Under the **Export** disclosure: **Copy results as table** copies text that pastes into a spreadsheet, and **Save results as CSV…**, **Save results as JSON…** and **Open results in editor** export the results on screen. Both **Save results as CSV…** and **Copy results as table** put an apostrophe in front of text that a spreadsheet would run as a formula (see [apostrophes in CSV files](#batch-export-and-batch-update)); `filemaker.export.neutralizeFormulas` turns that off. For large exports use [batch export](#batch-export-and-batch-update).
- Under the **Copy request** disclosure: **Copy as curl** and **Copy as fetch()** copy the equivalent request. Authorization headers are left out unless you tick **Include auth header** (its starting value is `filemaker.snippets.includeAuthByDefault`).
- A find that matches nothing shows an empty result, not an error.

**Save…** stores the query under the profile in the sidebar (**Saved Queries**). Saved queries live in the workspace by default; set `filemaker.savedQueries.scope` to `global` to keep them in your user data. Run one from its right-click menu or **FileMaker: Run Saved Query**. **FileMaker: Export Saved Queries (JSON)** and **FileMaker: Import Saved Queries (JSON)** share them with a team. The panel keeps a short **Request history**, the last `filemaker.history.maxEntries` requests (default 10).

For a quick check without the panel, **FileMaker: Run Find (JSON)** asks for a layout and a find body.

---

## View, edit, create and delete records

### What a record ID is

A **record ID** is FileMaker's internal record number for a row on a layout (what `Get ( RecordID )` returns in FileMaker). It is not one of your key fields and it is not the order of the records on screen. The Query Builder results table shows it in the first column (`recordId`). You rarely need to type one: run a find in the Query Builder and use **View** or **Edit** on the row. The commands that ask for a record ID are for when you already have it from a result, a log or a script.

### View a record

Run **FileMaker: Get Record by ID** or **FileMaker: Open Record Viewer**, choose a profile and layout, and enter the record ID (or use **View** on a row in the Query Builder). The viewer shows the fields, portal data and container fields (images are previewed). **Export Record JSON** saves the record.

### Edit a record

1. Run **FileMaker: Open Record Editor** or **FileMaker: Edit Record by ID**, or select **Edit** in the Query Builder.
2. Choose a profile and layout and enter the record ID, or skip this and use **Edit** on a row in the Query Builder (the editor then opens with the record loaded). In the editor, **Load** fetches the record.
3. Change fields. **Validate** checks the values. **Preview Update JSON** shows exactly what will be sent.
4. Select **Save**. A dialog lists the fields that will change. Confirm with **Save**.

Only changed fields are sent. **Discard Changes** reverts the form.

**If someone else changed the record:** the editor sends the version of the record you loaded. If the record changed on the server since then, FileMaker refuses the edit (error 306) and nothing is written. The editor then shows which fields changed since you loaded the record, which of them you also edited, and keeps your edits in the form. Select **Reload record (discard my edits)** to load the current version, then make your change again. Batch update does not have this check.

If a save works but the editor cannot re-read the record afterwards, it says so and asks you to select **Load** before editing again.

### Create a record

Run **FileMaker: Create Record** (or the plus icon on a layout). The Record Editor opens in create mode with the layout's field list. Fill in the fields you want, select **Create Record**, and confirm the dialog ("Create a new record in layout ..."). The editor then shows the new record's ID.

### Delete a record

Run **FileMaker: Delete Record**, choose a profile and layout, and enter the record ID. Because a mistyped ID deletes the wrong record, look the ID up first: run a find in the Query Builder and read the `recordId` of the row you mean. A dialog then asks you to confirm with **Delete**, naming the ID and the layout. Deleting cannot be undone.

Editing, creating, deleting and uploading all need a trusted workspace (checked each time; an open editor refuses changes if trust is lost), are blocked in offline mode and for the enterprise `viewer` role, and respect `filemaker.features.recordEdit.enabled`. Deleting also needs the general write permission (`writeOperations`) in addition to record editing.

---

## Upload to a container field

1. Run **FileMaker: Upload to Container**, or select **Upload to container…** in the Query Builder.
2. Choose a profile and layout, then enter the record ID and the container field name.
3. Pick the file.

The default size limit is 100 MB (`filemaker.containerUploadMaxBytes`). Uploading needs a trusted workspace.

---

## Batch export and batch update

Batch work runs as a **job** with a progress bar. Jobs appear under **Jobs** in the sidebar while they exist.

### Export

1. Run **FileMaker: Batch Export (Find)** (or use the layout's right-click menu).
2. Enter the find JSON array and an optional sort array.
3. Choose where to save. The file extension sets the format: `.jsonl` (one JSON record per line) or `.csv`.

Large results are fetched page by page. The export stops at `filemaker.batch.maxRecords` records (default 10,000; the hard limit is 250,000). With `filemaker.performance.mode` set to `high-scale`, exports are always written as JSONL.

**Apostrophes in CSV files.** A spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` as a formula, and database text can start that way. The export therefore puts an apostrophe in front of such text, so `=SUM(A1)` is saved as `'=SUM(A1)`. The same applies to text that starts with a tab or a carriage return. Plain numbers (`-5`), signed numbers and phone numbers such as `+1 (555) 123-4567` are left alone. If another program reads the CSV, strip the leading apostrophe there. The same applies to **Save results as CSV…** and **Copy results as table** in the Query Builder.

**Editing and re-importing a CSV export.** A CSV export has `recordId` and `modId` columns followed by every field the layout returns. Batch update skips the `recordId` and `modId` columns as fields (using `recordId` to find each record), so a layout with plain fields can be edited and imported back. But the export also writes related (`Table::Field`), calculation, summary and container columns, and import sends every column back as a field. Before importing, delete the columns for related, calculation, summary and container fields and keep only the fields you want to change. Empty cells are skipped. A cell that looks like JSON (for example `{"a":1}`, `[1,2]`, `true`, `null` or a number) is sent as JSON, not as text. A JSONL export cannot be imported: batch update accepts `.csv` and `.json` only.

**Turning the apostrophe off.** If you need the raw text (for example a program that does not understand the apostrophe), set `filemaker.export.neutralizeFormulas` to `false` in your **user** settings. It applies to CSV exports and **Copy results as table**; a workspace cannot change it. JSON Lines exports never had the apostrophe.

### Update

1. Run **FileMaker: Batch Update from CSV/JSON** (or the layout's right-click menu).
2. Choose a `.csv` or `.json` file.
   - **CSV**: a header row with a `recordId` column and one column per field. Empty cells are skipped (a CSV cannot clear a field).
   - **JSON**: an array of `{ "recordId": "123", "fieldData": { "Field": "value" } }` entries (`recordId` is a string).
3. Choose **Dry-run only (recommended)** or **Execute updates now**. A dry run shows a sample of what would be sent and sends nothing. Executing asks for a final confirmation first.

Updates run with `filemaker.batch.concurrency` requests at a time (default 4, maximum 10). There is no undo. Keep an export from before the update. It can restore old values only for layouts without related, calculation, summary or container fields, and only after you delete those columns (see above).

Batch update is blocked in offline mode, for the `viewer` role, and when `filemaker.features.batch.enabled` is off or the workspace is untrusted.

---

## Run scripts

1. Run **FileMaker: Open Script Runner** (or use a layout's right-click menu).
2. Choose a profile and a layout. FileMaker runs scripts in the context of a layout.
3. Type the script name exactly as it appears in FileMaker. Add a record ID and a parameter if the script needs them. **Build Parameter** helps you assemble a JSON parameter.
4. Select **Run Script**. The result appears below. **Copy as curl** and **Copy as fetch()** copy the request.

The Script Runner does not ask for confirmation, so check the script name before you run it. Running scripts is blocked in offline mode, for the `viewer` role, and when `filemaker.features.scriptRunner.enabled` is off. A workspace setting can only switch this off, never on.

---

## Schema snapshots and diffs

A snapshot records a layout's fields and metadata at a moment in time, so you can see what changed.

1. Right-click a layout and choose **Capture Schema Snapshot** (or run **FileMaker: Capture Schema Snapshot**).
2. Later, choose **Diff Against Latest Snapshot** on the layout, or **FileMaker: Diff Schema Snapshots** to compare any two.
3. The **Schema Diff** panel shows added, removed and changed fields side by side or as a tree. **Export Diff JSON** saves it.

Layout names that contain `..` (for example `Q1..Q2`) are supported in snapshots and the offline cache. Snapshots are stored in `.vscode/filemaker/snapshots/` in a trusted workspace (`filemaker.schema.snapshots.storage` = `workspaceFiles`, the default), or in VS Code workspace storage in an untrusted one. The newest 20 per layout are kept (`filemaker.schema.snapshots.maxPerLayout`). Treat the files as internal project data: they contain your layout and field names.

With `filemaker.schema.diagnostics.enabled`, changes found by **Diff Against Latest Snapshot** are also listed in the Problems panel.

**FileMaker: Open Schema Snapshot JSON** opens a snapshot file.

---

## Generate types, a client and snippets

Generation writes files into your workspace, so it needs a **trusted workspace**.

| Command | What it writes |
| --- | --- |
| **FileMaker: Generate Types for Layout** | `<output folder>/layouts/<layout file name>.ts`, a TypeScript interface for one layout |
| **FileMaker: Generate Types for All Layouts** | the same, for every layout. A layout whose metadata cannot be read is skipped (the reason goes to the Output channel) and the rest are still generated. |
| **FileMaker: Generate TypeScript Client** | first asks you to tick the layouts to include (a multi-select list), then for a folder, then writes `types.ts`, `client.ts` and `README.md` there |
| **FileMaker: Generate Snippets for Layout** | adds two editor snippets to `snippets/filemaker-data-api.code-snippets` in the workspace root. They call this extension's commands (`filemakerDataApiTools.runFindJson` and `filemakerDataApiTools.getRecordById`) from VS Code extension code; they are not Data API client snippets. |

The output folder is `filemaker.typegen.outputDir` (default `filemaker-types`, inside the workspace). **FileMaker: Open Generated Types Folder** opens it.

**File names.** A layout name made only of letters, digits, `_`, `.` and `-` is used as it is (`Contacts.ts`). If the name has any other character (a space, `/`, `:`, accents), the unusable characters become `_` and a short hash of the original name is added, for example `My_Layout-1a2b3c4d.ts`. Two layouts whose names differ only in punctuation therefore get separate files. Reserved Windows names such as `CON` get a safe name. Names that differ only in letter case can still collide on a case-insensitive file system. If you generated files with an older version, delete the old files for layouts whose names have spaces or punctuation.

Database names are escaped when they are written into comments, strings and snippets, so a layout name cannot put code in a generated file.

Regenerate after a schema change, and use a [schema diff](#schema-snapshots-and-diffs) to see which fields moved.

---

## FM Web and Layout Mode

FM Web is an experimental workflow for designing web layouts that sit on top of your FileMaker data and generating a small Next.js app from them. Everything is under `.fmweb/` in the workspace and needs a trusted workspace.

1. **FileMaker: Initialize FM Web Project** creates `.fmweb/`.
2. **FileMaker: Select Active Profile** and **FileMaker: Sync FM Web Project Metadata** copy layout, field and script metadata into `.fmweb/metadata`.
3. **FileMaker: Open FM Web Layout Mode** opens the designer. Layouts are saved in `.fmweb/layouts`.
4. **FileMaker: Generate FM Web Next.js App** and **FileMaker: Generate FM Web Layout Page** write the app to `.fmweb/generated`.
5. **FileMaker: Start FM Web Preview Server** starts a local bridge (bound to `127.0.0.1`) and runs the app. **The preview needs the source repository.** The Marketplace extension does not include the preview app template, so in a Marketplace installation this command (and **Generate FM Web Next.js App**) stops with "The FM Web preview is not available in this installation". Layout Mode and metadata sync work everywhere. To use the preview, work from a clone of the repository (see [CONTRIBUTING.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/CONTRIBUTING.md)).

Confirmations you will see:

- **Start FM Web Preview Server** shows the folder and asks before it runs `npm install` and `npm run dev` there. The folder's `package.json` can come from a repository, and npm runs the scripts it defines. Only continue if you trust it.
- **A layout button that runs a script** (a `runScript` behavior) asks before it runs, naming the script, the parameter and the connection, and saying when the project file chose that connection. It also needs the script runner enabled, offline mode off and a policy that allows scripts.

The bridge accepts requests only from your own computer, it needs a trusted workspace, every request must carry a session token, and it serves only the active connection. The token is written to a private `.env.local` in the generated app and sent by the generated client; apps you generated earlier get their managed runtime files refreshed to the current template, and an app whose files you edited is left alone with a warning. Record changes and script runs follow your own limits:

- Record changes (edit, create, delete) are refused in offline mode, when `filemaker.features.recordEdit.enabled` is off, and when the enterprise role or `disabledFeatures` disallow `writeOperations` or `recordEdit`.
- Script runs are refused in offline mode, when `filemaker.features.scriptRunner.enabled` is off, and when the enterprise role or `disabledFeatures` disallow `scriptRunner`.

For the layout file format, architecture and bridge security details, see [FM_WEB.md](./FM_WEB.md).

---

## Offline mode

Offline mode keeps you working with what the extension has already learned about your schema, and blocks changes.

1. Run **FileMaker: Toggle Offline Mode**. The sidebar shows an **OFFLINE MODE** badge.
2. Layout and field metadata is served from a cache in `.vscode/filemaker/offline-metadata/`. The extension fills the cache whenever it reads layout metadata while online. **FileMaker: Refresh Offline Metadata Cache** caches every layout of a profile in one go. A layout you never opened shows "no cached metadata".
3. Writes are disabled: record edit, create, delete and upload, batch update, the Script Runner, and adding, editing or removing profiles.
4. A warning appears when the cache is older than `filemaker.offline.staleCacheWarnHours` (default 24).

Offline mode does not block finds or opening records: those still call the server, and fail if it is unreachable.

**Turning it off.** Run **FileMaker: Toggle Offline Mode** again. The command changes your **user** setting and tells you the mode that is really in effect. If a workspace setting (for example `offline.mode: true` written into `.vscode/settings.json` by an older version of this extension) keeps offline mode on, the message says so ("still on because of ...") and the command cannot clear it: edit the workspace setting yourself. A workspace can turn offline mode on but never off. Offline mode set in your user settings applies to every workspace you open.

---

## Enterprise mode and roles

Enterprise mode adds role-based limits for shared or regulated environments. It is off by default.

Set `filemaker.enterprise.mode` to `true` and `filemaker.enterprise.role` to one of:

| Role | What it can do |
| --- | --- |
| `viewer` | Read only. Blocked: record edit, create, delete, upload, batch update, the Script Runner, profile add/edit/remove, environment set creation, export of comparison reports, plugins. |
| `developer` (default) | Everything except exporting environment comparison reports and loading plugins. |
| `admin` | Everything. |

A team can also put `.vscode/filemaker.config.json` in a repository:

```json
{
  "enterpriseMode": true,
  "role": "viewer",
  "lockedProfiles": ["<profile id>"],
  "disabledFeatures": ["batchUpdate", "scriptRunner"],
  "enforcedPerformanceMode": "standard",
  "defaultEnvironmentSets": [{ "name": "All", "profiles": ["<profile id>"] }]
}
```

The feature names for `disabledFeatures` are `recordEdit`, `batchUpdate`, `environmentExport`, `pluginInstall`, `scriptRunner`, `writeOperations` and `ai`.

**Restrict-only.** A repository can make the policy stricter but never looser. A workspace setting or this file can turn enterprise mode on and lower the role, but it cannot turn enterprise mode off or raise the role above the one in your own user settings (the default is `developer`). If you used a repository file to grant `admin`, set it in your user settings instead. In the same way, a workspace can switch offline mode on or a `filemaker.features.*.enabled` switch off, but not the reverse.

**Environment Sets** group profiles (for example Dev, Staging, Production) so you can compare them. With enterprise mode on, use **FileMaker: Create Environment Set**, **FileMaker: Compare Environments**, **FileMaker: Diff Layout Across Environments**, **FileMaker: Export Environment Comparison Report** and **FileMaker: Open Environment Set JSON**.

---

## Plugins

Plugins are JavaScript modules that add commands and tree views. The extension looks for them in `.vscode/filemaker-plugins/` in a trusted workspace.

A plugin runs with the same access as the extension: your saved connections and sessions. So the extension asks first:

1. When it finds plugins, a dialog names the files and the workspace. Choose to run them only if you trust the repository.
2. The extension hashes **every file** in the folder. Your approval is remembered for that workspace and that exact content. If any file is added, changed or removed, you are asked again.
3. A folder with more than 500 files, more than 20 MB in total, or a symbolic link, is refused with a message saying why.

Plugins are not loaded in an untrusted workspace, and in enterprise mode only for roles that allow `pluginInstall` (`admin`). Anything a plugin loads from outside its folder is not checked. **FileMaker: List Active Plugins** and **FileMaker: Reload Plugins** are in the Command Palette when `filemaker.advanced.powerUserMode` is on.

---

## Using AI with FileMaker

AI features are **off by default**. Nothing is read by an AI tool until you turn it on in your own user settings and choose a connection.

> **Read this first.** Anything an AI tool reads is sent to the AI model provider you use, and it can leave through any shell, web or git tool the same agent has. Field values and names are text from your database; a hostile value or name can try to steer an agent. The controls below reduce this. They do not remove it. Connect with a dedicated FileMaker account that has a read-only privilege set: it is the only control that does not depend on the model or on you.

There are three parts, and you can use them separately:

| Part | What it does | Where the data goes |
| --- | --- | --- |
| **Write AI Context** | Writes a Markdown file of layout, field and script names for AI coding tools to load | Only to the file you choose; no record data |
| **AI tools in VS Code** | Lets agent mode in VS Code (for example Copilot) read records and, if allowed, change them | To the model provider VS Code uses |
| **External MCP server** | Lets Claude Code, Cursor and other MCP clients use the same tools | To the provider behind that client |

### Minimum to try it

Read-only, about five minutes:

1. Connect to a server as in [First run in 10 minutes](#first-run-in-10-minutes). Use an account whose privilege set is read-only.
2. Open your **user** settings (see [Opening your user settings](#opening-your-user-settings)) and add `"filemaker.ai.enabled": true`.
3. Run **FileMaker: Set AI Access for Connection**, pick the connection, choose **Read**, and answer **Use for AI Tools**.
4. Open an AI agent in VS Code that supports tools (for example Copilot in agent mode) and ask it to list the layouts of your FileMaker database. The first time it reads a layout, VS Code shows a prompt from this extension; approve it.
5. To stop at any time, select the `AI:` item in the status bar.

Nothing else is needed. Writes and scripts stay unavailable until you switch them on (see Rules and limits below). The rest of this chapter explains what each part does and what protects you.

### Write AI Context

AI models guess layout and field names and get find requests wrong. This command gives them the real names.

1. Run **FileMaker: Write AI Context**.
2. Choose a connection if asked, then tick the layouts to describe. None are selected by default and the limit is 50.
3. The extension reads their fields and the script names and writes a Markdown file of at most 20 KB.

What is in it: the connection name, database name, and the names of the layouts, fields and scripts you picked. What is not: record data, value-list values, field descriptions, the server address, the user name or any credential.

Where it goes: by default, the extension's storage folder (outside any repository). You are offered **Open File**, and **Copy into Workspace** (to `.filemaker/ai-context.md`). If the file lands inside the workspace, you are asked whether to add it to `.gitignore`, because it holds database structure.

To write into a file of your own, such as `AGENTS.md`, set `filemaker.ai.contextPath` in your **user** settings to a path relative to the workspace folder (or any file inside the workspace). If the file already exists without the markers, the command asks and, if you choose **Add Section**, appends a new section at the end and leaves the rest alone. To control where the section goes, add the two marker lines `<!-- filemaker-ai-context:start -->` and `<!-- filemaker-ai-context:end -->` where the section should go. The command replaces only the text between them and refuses to touch anything else. Symbolic links, `.git` and paths outside the workspace are refused, and a workspace cannot set this path.

Names are cleaned: letters, digits, space and `_ - . : ( )`, up to 64 characters. Anything else becomes a placeholder and is counted in the file header. The file says its content is data. A name made only of allowed characters can still read like an instruction to a model, so treat the file as data and keep it out of public repositories.

### AI tools in VS Code (agent mode)

To let an agent use a connection:

1. In your **user** settings, turn on `filemaker.ai.enabled`. A workspace setting cannot turn it on.
2. Run **FileMaker: Set AI Access for Connection**, pick the connection, and choose **Read** (or **Write**, see below). A message then reminds you to use a restricted account and offers **Use for AI Tools**, which sets `filemaker.ai.connection`. A profile's AI access is reset to none when you change its server, user, database or API paths, so you set it again after such an edit. A repository file cannot choose the connection.
3. Open the agent in VS Code. The tools appear in its tool list.

The status bar shows the state: `AI: off`, `AI: off (connection not enabled)`, `AI: read-only`, `AI: writes on` or `AI: scripts on`. The hover text shows records read, write attempts used and the FileMaker account in use.

### Rules and limits

These are the controls the extension applies. They are the reasons it is safe to try; read them before you allow writes or scripts.

- **Read-only.** The tools that read are `fm_list_layouts`, `fm_describe_layout`, `fm_list_scripts`, `fm_find_records`, `fm_get_record` and `fm_explain_error`. Write tools are not offered at all until you switch them on.
- **Writes are opt-in.** `filemaker.ai.allowWrites` adds `fm_edit_record`, `fm_create_record` and `fm_delete_record` (one record per call), and the connection must be set to **Write**. `filemaker.ai.allowScripts` adds `fm_run_script`, which also needs the connection's access to be **Write** and is limited to the scripts you list in `filemaker.ai.scriptAllowlist`, for example `{"<profile id>": ["Export Report"]}`. These settings are read from your user settings only.
- **Every write is confirmed by you.** Each change opens a dialog built by the extension from a fresh read of the record. VS Code cannot set it to "always allow". It shows the connection, layout, record, every field with the old and new value, and the AI's own description, labelled as the AI's. Deleting asks you to type the record ID. A record changed in the meantime is not overwritten. A write is limited to 10 fields and 200 characters per value, and the whole dialog text to 4,000 characters (escaped characters take extra room), so that the dialog can show all of it; a larger write is refused.
- **You approve each layout.** The first read of a layout in a session asks you (at most 20 layouts a session). List layouts you trust in `filemaker.ai.readableLayouts` to skip the question.
- **Limits.** 50 records per call, 500 records per session, 30 calls a minute, 10 write attempts per session and 3 a minute (a declined attempt counts). Results are capped at 200 KB.
- **Hidden fields.** `filemaker.ai.hiddenFields` lists field names AI tools never see (case-insensitive, with or without `Table::`). This is by name only. It does not stop disclosure through a calculation, a summary field or a script result.
- **Offline mode** blocks AI reads as well as writes. AI tools are not registered in an untrusted workspace.
- **Left out of results:** container fields and URLs, and the server address. Text that looks like a secret is redacted, which can rewrite a field value that looks like one; writes refuse values that contain the redaction marker.

### Kill switch, sessions and activity

Three commands exist for this. They appear in the Command Palette only while AI tools are active (switched on and offered); the status bar item always works.

- **FileMaker: Switch AI Tools Off or On**, or select the `AI:` status bar item, switches every AI tool off at once. Select the status bar item again to switch back on; you are asked first. Switching off and on does not reset any limit. While tools are switched off the command is hidden from the palette, so use the status bar item to turn them back on.
- **FileMaker: Start New AI Session** resets the record quota, the write counters and all layout approvals, after asking you.
- **FileMaker: Show AI Activity** opens a log of what was called: tool, connection, layout, record IDs, outcome and whether you confirmed. It does not record field values, is kept outside the workspace, and is capped at 256 KB.

**Keep policy in your user settings.** A workspace file can be edited by an agent that has file-editing tools. Put `filemaker.ai.hiddenFields` and the enterprise switches (`filemaker.features.ai.enabled`, an `ai` entry in `disabledFeatures`) in your user settings, or in an enterprise-managed location, not only in `.vscode/settings.json`. A workspace or enterprise file can switch AI off through `filemaker.features.ai.enabled` or `disabledFeatures`, and cannot switch it on.

### Claude Code, Cursor and other MCP clients

The same tools, with the same limits, approvals and dialogs, are available to MCP clients that run outside VS Code. This is off by default and works only in local VS Code windows, not in Dev Containers, Codespaces, SSH or WSL windows (the server will not start there).

1. Set up AI access as above (turn on `filemaker.ai.enabled`, set a connection).
2. In the window you want to use, run **FileMaker: Start/Stop AI Server for External Tools**. The command always asks in a dialog first; the dialog says the server will start automatically each time you open this workspace. If `filemaker.ai.externalServer.enabled` is off, the same dialog turns it on in your user settings. Nothing can start the server, or make it start automatically, without that dialog. The status bar item then reads `AI: ... · MCP`, and its tooltip shows the number of connections. Running the command again to stop the server asks nothing.
3. Run **FileMaker: Copy MCP Config for Claude Code / Cursor** and paste the result into Claude Code's `.mcp.json` (or use `claude mcp add-json filemaker '<the filemaker entry>'`) or into Cursor's `mcp.json`. The config points at a copy of the client program (`aiMcpShim.js`) kept in the extension's storage, in a folder only you can use, so it keeps working after extension updates. If the copy could not be made, the message says so and you copy the config again after an update.
4. The client starts that small program with `node`, and it connects to your VS Code window. **Node.js 18 or newer must be on the PATH of the client**; without it the config cannot run.

**The setting is a permission, not a switch.** `filemaker.ai.externalServer.enabled` (user settings only) only allows the server; it never starts it. A window runs the server only after you ran **Start/Stop AI Server for External Tools** in that window and confirmed. VS Code remembers that for that workspace and starts the server again each time you open it, while the setting is on, until you run the same command there to stop it. Stopping persists, also after a restart. Turning the setting off stops the server in every window where it runs and ends the automatic start for every workspace, including closed ones; turning the setting on again does not bring them back, and you start the server there again by running the command. A window you never started it in never runs it.

How it is protected: a socket in a folder only you can use (on Windows an unguessable named pipe), the folder name includes a hash of the product's storage path so VS Code, Insiders and Cursor do not share one; a secret per-session token in a file only you can read; the program checks that the window that wrote the file is still the same process before it sends the token. With several windows running the server, the config names the folder and the program refuses to guess. You get a notification when a program connects (at most one every 30 seconds), and the connection count is in the status bar tooltip. The name an MCP client gives itself appears only in **Show AI Activity**, never in a dialog. Layout approvals and write dialogs still appear in VS Code, and if the client cancels or disconnects while a dialog is open, nothing is sent whatever you answer. Everything the tools return is sent to the provider behind your MCP client, which is often a different provider from the one VS Code uses.

---

## User settings vs Workspace settings in plain words

VS Code has two places to set most options. **User settings** are yours and follow you to every project. **Workspace settings** live in the project (`.vscode/settings.json`) and apply only there, to everyone who opens it. A project can therefore ship settings you did not choose, so this extension does not let a project loosen anything that protects you. That is why a value you type in the **Workspace** tab can seem to do nothing. There are three kinds of setting:

| Kind | What the Workspace tab does | Examples |
| --- | --- | --- |
| **User settings only** | Nothing. A workspace value is ignored (VS Code may not even show the setting in the Workspace tab). | all `filemaker.ai.*` settings except `hiddenFields`, `filemaker.secrets.fallback`, `filemaker.export.neutralizeFormulas` |
| **Workspace can only make this stricter** | A value that adds a restriction counts; one that would loosen your user value is ignored. | `filemaker.offline.mode` (can only turn on), `filemaker.features.*.enabled` (can only turn off), `filemaker.enterprise.mode` (can only turn on), `filemaker.enterprise.role` (can only lower), `filemaker.ai.hiddenFields` (can only add names) |
| **Per workspace** | Works as you expect. Some are ignored until you trust the folder. | `filemaker.savedQueries.scope`, `filemaker.typegen.outputDir`, `filemaker.schema.snapshots.storage`, `filemaker.batch.*`, timeouts, and the rest |

Every setting's description in the Settings editor starts with one of these three labels.

**See what is really in effect.** Run **FileMaker: Show Effective Settings**. For every policy-related setting it shows the value in effect, where it comes from (Default, User, Workspace, Workspace Folder, Enterprise file or Restricted Mode), your User and Workspace values and, when a workspace value is ignored, a plain sentence saying why, with buttons to open the User or Workspace tab at that setting. The value in effect is read by the same code that applies the rule (and for the on/off switches the explanation is built from the same reading); the page is a snapshot that refreshes when settings change. When a project ships a value that is ignored, the extension also tells you once per setting for that workspace, with **Don't show again for this workspace**.

Limits worth knowing. In **Restricted Mode** VS Code hides workspace values of the restricted settings, so the page says they are ignored until you trust the folder, and the extension does not read the workspace settings files at all. In a trusted workspace it reads `.vscode/settings.json` and the `.code-workspace` file only to catch User-only settings (VS Code hides those); a file that is large, a link or not valid JSON is reported instead of being used. In a multi-root workspace a folder's `.vscode/settings.json` applies only to files in that folder, not to these window-wide settings.

**Saved query scope.** `filemaker.savedQueries.scope` stores `workspace` or `global`. `workspace` keeps queries for this workspace on this computer (VS Code stores them; they are not in your project files, and other workspaces do not see them); `global` makes them available in every workspace on this computer (on each machine separately in a remote window). Changing it does not move queries you already saved.

---

## Settings reference

Open Settings (`Cmd+,` / `Ctrl+,`) and search for `filemaker`; make sure the **User** tab is selected for the user-only settings (or see [Opening your user settings](#opening-your-user-settings)). Not sure which value wins? Run **FileMaker: Show Effective Settings**. In the table, **Where** says where a value is read from:

- **User or workspace**: either; a workspace value applies only to that workspace.
- **User only**: read from your user settings only. A workspace or dev container value is ignored.
- **ignored in an untrusted workspace**: in Restricted Mode the setting's workspace value is not used.
- **Workspace can only make it stricter**: a workspace may turn offline mode on, a feature off, enterprise mode on, or the role lower, and never the reverse. A workspace value that would loosen your user value is ignored. Details: [User settings vs Workspace settings in plain words](#user-settings-vs-workspace-settings-in-plain-words).
- **(T)**: VS Code ignores the workspace value in an untrusted workspace (Restricted Mode).

**Connection**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemaker.requestTimeoutMs` | `15000` | User or workspace | Timeout for each Data API request, in milliseconds. |
| `filemaker.defaultApiBasePath` | `"/fmi/data"` | User or workspace | API path used when a profile does not set one. |
| `filemaker.defaultApiVersionPath` | `"vLatest"` | User or workspace | Data API version segment used when a profile does not set one. |
| `filemaker.connect.maxRetries` | `3` | User or workspace | Retries of a failed sign-in on network or server errors. 0 turns retry off. |
| `filemaker.connect.backoffInitialMs` | `1000` | User or workspace | Delay before the first sign-in retry, in milliseconds. |
| `filemaker.connect.backoffMaxMs` | `30000` | User or workspace | Longest delay between sign-in retries, in milliseconds. |
| `filemaker.connect.backoffMultiplier` | `2` | User or workspace | Factor by which the retry delay grows. |
| `filemaker.connectionWizard.requireTestBeforeSave` | `"warn"` | User or workspace | `off`, `warn` or `block`: whether saving a profile needs a successful Test Connection. |
| `filemaker.session.maxAgeMinutes` | `14` | User or workspace | Treat a session token as expired this many minutes after it was issued. |
| `filemaker.session.refreshLeadSeconds` | `30` | User or workspace | Renew the token this many seconds before it expires. 0 turns early renewal off. |
| `filemaker.secrets.fallback` | `"vscode-only"` | User only | What to do when VS Code SecretStorage is unavailable: `vscode-only` (error), `workspace-state` (obfuscated copy keyed from the machine id; not protection against anyone with local access to VS Code state), `disabled` (do not store secrets; development only). |

**Queries and History**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemaker.savedQueries.scope` | `"workspace"` | User or workspace | Where saved queries are kept: `workspace` (this workspace on this computer, not in your project files) or `global` (every workspace on this computer). |
| `filemaker.history.maxEntries` | `10` | User or workspace | Request history entries kept per workspace. |
| `filemaker.snippets.includeAuthByDefault` | `false` | User or workspace | Include authorization headers in Copy as curl and Copy as fetch(). |

**Records, Scripts, and Batch**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemaker.features.scriptRunner.enabled` | `true` | Workspace can only make it stricter (T) | Turns the Script Runner off when false. |
| `filemaker.scripts.parameterBuilder.enabled` | `true` | User or workspace | Shows the JSON parameter builder in the Script Runner. |
| `filemaker.export.neutralizeFormulas` | `true` | User only | Put an apostrophe in front of CSV cells and Copy results as table cells that start with `=`, `+`, `-`, `@`, tab or carriage return. Turn off only if you need the raw text. |
| `filemaker.batch.maxRecords` | `10000` | User or workspace (T) | Most records a batch export fetches. |
| `filemaker.batch.concurrency` | `4` | User or workspace (T) | Requests sent at a time by a batch update (1 to 10). |
| `filemaker.batch.dryRunDefault` | `true` | User or workspace (T) | Default mode shown for batch updates. |
| `filemaker.features.recordEdit.enabled` | `true` | Workspace can only make it stricter (T) | Turns the Record Editor write-back and container upload off when false. |
| `filemaker.containerUploadMaxBytes` | `104857600` | User or workspace | Largest file Upload to Container accepts, in bytes (default 100 MB). |
| `filemaker.features.batch.enabled` | `true` | Workspace can only make it stricter (T) | Turns batch export and update off when false. |
| `filemaker.performance.mode` | `"standard"` | User or workspace | `standard` or `high-scale`. High-scale writes batch exports as JSONL. |

**Schema**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemaker.schema.cacheTtlSeconds` | `300` | User or workspace | How long layout metadata is cached, in seconds. |
| `filemaker.schema.metadataEnabled` | `true` | User or workspace | Looks up layout metadata for the sidebar, inspector and editors. |
| `filemaker.schema.snapshots.storage` | `"workspaceFiles"` | User or workspace | `workspaceFiles` (`.vscode/filemaker/snapshots/`) or `workspaceState`. An untrusted workspace always uses `workspaceState`. |
| `filemaker.schema.snapshots.maxPerLayout` | `20` | User or workspace | Snapshots kept per layout; the oldest are removed. |
| `filemaker.schema.diagnostics.enabled` | `false` | User or workspace | Lists snapshot differences in the Problems panel. |
| `filemaker.schema.hashAlgorithm` | `"sha256"` | User or workspace | Hash used to fingerprint schema metadata. |

**Code Generation**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemaker.typegen.outputDir` | `"filemaker-types"` | User or workspace (T) | Workspace folder for generated types (a relative path inside the workspace; a leading `/` is dropped and a path with `..` falls back to the default). |

**FM Web Projects**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemaker.fmWeb.bridge.rateLimitPerSecond` | `20` | User or workspace | Sustained requests per second the FM Web bridge accepts. Extra requests get HTTP 429. |
| `filemaker.fmWeb.bridge.rateLimitBurst` | `60` | User or workspace | Largest burst the FM Web bridge accepts at once. |
| `filemaker.fmWeb.bridge.requestBudget` | `10000` | User or workspace | Total requests per bridge session; restart the bridge to reset. |

**Offline Mode**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemaker.offline.mode` | `false` | Workspace can only make it stricter (T) | Use cached metadata and block writes. |
| `filemaker.offline.staleCacheWarnHours` | `24` | User or workspace | Warn when the offline cache is older than this many hours. 0 turns the warning off. |

**Enterprise**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemaker.enterprise.mode` | `false` | Workspace can only make it stricter (T) | Turns on role-based limits. |
| `filemaker.enterprise.role` | `"developer"` | Workspace can only make it stricter (T) | `viewer`, `developer` or `admin`. |

**Advanced**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemakerDataApiTools.logLevel` | `"info"` | User or workspace | Old name of `filemaker.logging.level`. |
| `filemakerDataApiTools.requestTimeoutMs` | `15000` | User or workspace | Old name of `filemaker.requestTimeoutMs`. |
| `filemakerDataApiTools.defaultApiBasePath` | `"/fmi/data"` | User or workspace | Old name of `filemaker.defaultApiBasePath`. |
| `filemakerDataApiTools.defaultApiVersionPath` | `"vLatest"` | User or workspace | Old name of `filemaker.defaultApiVersionPath`. |
| `filemaker.advanced.powerUserMode` | `false` | User or workspace | Shows jobs, history, diagnostics dashboard, circuit breaker and plugin commands in the Command Palette. |
| `filemaker.logging.level` | `"info"` | User or workspace | Log level for the Output channel: `debug`, `info`, `warn`, `error`. |

**AI Tools**

| Setting | Default | Where | What it does |
| --- | --- | --- | --- |
| `filemaker.ai.contextPath` | `""` | User only | File that Write AI Context writes. Empty means the extension storage folder. |
| `filemaker.ai.enabled` | `false` | User only | Lets AI tools in VS Code use the connection in `filemaker.ai.connection`. |
| `filemaker.ai.allowWrites` | `false` | User only | Offers the tools that create, edit and delete one record. Needs connection access Write. |
| `filemaker.ai.allowScripts` | `false` | User only | Offers the tool that runs scripts from the allowlist. |
| `filemaker.ai.scriptAllowlist` | `{}` | User only | Scripts AI tools may run, by profile id: `{"<profile id>": ["Script Name"]}`. |
| `filemaker.ai.readableLayouts` | `{}` | User only | Layouts AI tools may read without asking, by profile id. |
| `filemaker.ai.hiddenFields` | `[]` | Workspace can only add names | Field names AI tools never see. A workspace can add names, not remove yours. |
| `filemaker.ai.connection` | `""` | User only | Profile id AI tools use. Set it with Set AI Access for Connection. |
| `filemaker.features.ai.enabled` | `true` | Workspace can only make it stricter (T) | A workspace or enterprise switch that can turn AI tools off. It cannot turn them on. |
| `filemaker.ai.externalServer.enabled` | `false` | User only | Permission for MCP clients (Claude Code, Cursor) to use the AI tools through a local server. It never starts the server; you start it in a window with Start/Stop AI Server for External Tools. |

Old names: `filemakerDataApiTools.logLevel`, `.requestTimeoutMs`, `.defaultApiBasePath` and `.defaultApiVersionPath` still work but are replaced by `filemaker.logging.level`, `filemaker.requestTimeoutMs`, `filemaker.defaultApiBasePath` and `filemaker.defaultApiVersionPath`. A more specific value wins whichever name it uses. The extension offers a one-click migration.


---

## Security behavior you will notice

- **Workspace trust.** In an untrusted workspace (Restricted Mode, see [above](#trusted-workspace-and-restricted-mode)) you can browse, read metadata and run finds. Editing, creating and deleting records, uploading to containers, the Script Runner, batch export and update, writing files (type generation, snippets, snapshots on disk, the AI context copy, FM Web), plugins, the FM Web preview and AI tools need a trusted workspace. Trust is checked each time, and an open panel refuses changes if trust is lost. This is not a free pass in a trusted workspace: the prompts below still apply.
- **Virtual workspaces** (such as github.dev) are not supported: the extension writes files to a folder on disk.
- **Prompts before risky actions.** You are asked before: saving a record (lists the changed fields), deleting a record, running a batch update, running workspace plugins, starting the FM Web preview (`npm install`, `npm run dev`), running a script from a Layout Mode button, switching AI tools back on, every AI write, and sending credentials to a template-supplied address or a remote `http://` address.
- **Secrets stay in the keychain.** Passwords, API keys and session tokens are kept in VS Code SecretStorage and never shown in webviews.
- **Redaction.** Logs, request history, error details and copied snippets hide authorization headers, session tokens (including in request paths), token-like query parameters and JSON keys (anything containing `token`, `secret`, `password`, `session` or `apiKey`), and passwords inside URLs. Copy as curl and Copy as fetch() leave out authorization unless you opt in.
- **Repositories cannot loosen your policy.** Workspace settings and `.vscode/filemaker.config.json` can only restrict enterprise mode, roles, offline mode and feature switches.
- **No telemetry.** The extension sends nothing to its authors. It talks only to your FileMaker server (or your proxy).
- **Local files that hold schema.** Snapshots, the offline cache, generated types and the AI context file contain layout and field names. Do not commit them to a public repository.

For the full picture, see [docs/security.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/docs/security.md) and [docs/DATA_HANDLING.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/docs/DATA_HANDLING.md).

---

## Troubleshooting

The most common first-run failure is a **certificate error** (the first row of the table below). If you see "self-signed certificate" or "unable to verify the first certificate", start there.

### Where to look first

- **Output panel:** View > Output, then choose **FileMaker Data API Tools** in the dropdown. Set `filemaker.logging.level` to `debug` for more detail. Secrets are redacted.
- **Error notifications** offer **Retry** (when a retry can help), **Edit Profile**, **Open Settings** and **Details…**. The details document shows the failing endpoint and the retry chain, redacted, and is safe to paste into a bug report.
- **FileMaker: Show Diagnostics** opens a report with your VS Code and extension versions, operating system, active profile (no secrets), settings and recent log lines. Attach it to bug reports.

### Common problems

| Problem | What to try |
| --- | --- |
| Certificate error ("self-signed certificate", "unable to verify the first certificate") | The server's certificate is not trusted by your computer. Best: in the connection wizard open **Certificates (advanced)** and set **Custom CA certificate file** to the PEM file of the authority that signed it. If you cannot, use **Trust this certificate…** from Test Connection and check the fingerprint with your administrator. Expired, not-yet-valid and wrong-name certificates get their own messages; for an expired or not-yet-valid one first check your computer's date and time. See [Certificates](#certificates-private-authority-or-self-signed). Installing the authority into your operating system's trust store also works. |
| "Connection refused", timeout, or no response | Check the server URL, VPN and firewall. The Data API must be enabled on the server. Raise `filemaker.requestTimeoutMs` for a slow server. |
| Sign-in fails with HTTP 401 or FileMaker error 212 | Wrong user name or password, or the account's privilege set lacks the `fmrest` extended privilege. Edit the profile, type the password again, and test. A missing `fmrest` privilege can look the same as a wrong password. |
| "Session expired" or error 952 | The Data API token timed out. The extension renews it and retries once on its own. If it keeps happening, disconnect and connect again, and check that nothing else is signing the same account out. |
| Error 956 (too many sessions) | The server reached its Data API session limit. Wait for idle sessions to expire, or ask the administrator to raise the limit. |
| HTTP 401 versus "no records" | They are different. **HTTP 401 means sign-in failed or the session was rejected.** FileMaker reports "no records match" as FileMaker error code 401 (sent with HTTP 404 or 500), and the extension shows it as an empty result. If a find unexpectedly returns nothing, check the criteria and the account's record access. |
| HTTP 403 | The account cannot use that layout, script or table. Check the privilege set. |
| HTTP 404 (no FileMaker error code) | Nothing answered at that address: check the Server URL, the API base path and version, the database name, and that the FileMaker Data API is enabled in the Admin Console (Connectors). A 404 that carries a FileMaker error code, or HTTP 405/501, means the server does not offer metadata for that layout; run **FileMaker: Refresh Schema Cache** or check the layout name. |
| "Sign-in is paused" | FileMaker rejected the saved account or password (error 210-214), so the extension stopped signing in by itself to avoid locking the account. Edit the connection, or run **Connect**. |
| "The server did not return Data API JSON" | A web page, firewall, proxy or sign-in page answered instead of FileMaker Server. Check the Server URL and base path. |
| Rejected sign-in on a FileMaker Cloud host | FileMaker Cloud signs in with a Claris ID token, which this extension does not support yet. |
| Error 105 (layout is missing) or 104 (script is missing) | The name is misspelled, was renamed, or the account cannot see it. |
| Error 306 on save | The record changed since you loaded it. See [edit a record](#edit-a-record). |
| Error 301 (record in use) | Another user or process has the record open. Try again later. |
| Errors 500 to 511 on save | The value failed the field's validation (date, range, unique, value list and so on). Change the value. |
| Proxy returns errors | Test the proxy endpoint outside VS Code. In proxy mode the proxy must keep the Data API request and response shapes, and the API key must be accepted. |
| Layouts or fields are missing in the sidebar | Select **Refresh Connections**, then **Refresh Schema Cache**. In offline mode, only cached layouts show. |
| Commands are greyed out or missing | You may be in an untrusted workspace, in offline mode, or limited by the enterprise role. The warning names the reason. Some commands appear only after you add a profile. |
| "Secret storage unavailable" | VS Code could not reach the OS keychain (common on Linux without a keyring, and in some remote windows). Install and unlock a keyring, or set `filemaker.secrets.fallback`. |
| The wizard asks for the password again | You changed the server address, proxy address or user name. This is intended. |
| A generated file has an unexpected name | See [file names](#generate-types-a-client-and-snippets). |
| CSV cells start with an apostrophe | See [apostrophes in CSV files](#batch-export-and-batch-update). |
| `AI: off` in the status bar | AI tools are off by default. See [Using AI with FileMaker](#using-ai-with-filemaker). |

### Reporting a problem

Open an issue at <https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/issues> and include: the extension and VS Code versions, your operating system, the server type and version, direct or proxy mode, the steps, and the redacted log or the **Show Diagnostics** report. Do not open a public issue for a security problem: see [SECURITY.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/SECURITY.md).

---

## FAQ

**Does the extension send data anywhere besides my server?** No. It has no telemetry. It talks only to your FileMaker server or proxy. AI features send data to an AI provider only if you turn them on, and only what a tool returns.

**Which FileMaker versions work?** Server 21 is the primary target; 19 and 20 are expected to work; FileMaker Cloud is untested. See [Compatibility](./COMPATIBILITY.md).

**Does it support OAuth or single sign-on?** No. Direct mode uses an account name and password. If you need another identity flow, put a proxy in front.

**Where are my profiles and queries stored?** Profiles in VS Code user data (secrets in the keychain). Saved queries in the workspace by default. Snapshots, the offline cache and generated files in the workspace. See [DATA_HANDLING.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/docs/DATA_HANDLING.md).

**Can I share connections with my team?** Share a [profile template](#profile-templates-for-a-team) (no secrets) and saved queries (export and import). Everyone enters their own password.

**Why can't I turn offline mode off?** A workspace setting (for example `offline.mode: true` in `.vscode/settings.json`) can keep it on, and the toggle cannot clear that. The message names the cause. See [Offline mode](#offline-mode).

**Why is the Command Palette missing some commands?** Many appear only with a profile; enterprise and power-user commands need those modes. See [The FileMaker sidebar](#the-filemaker-sidebar).

**Are there keyboard shortcuts?** None by default. Bind any command in VS Code's Keyboard Shortcuts editor.

**Can the extension edit scripts or layouts in the database?** No. It uses the Data API, which reads and writes records, runs scripts and reads metadata. It does not change the database design.

**Can I try it without a server?** The repository includes a mock Data API for development. See [CONTRIBUTING.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/CONTRIBUTING.md).

**Where do I get help or report a bug?** [GitHub issues](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/issues).
