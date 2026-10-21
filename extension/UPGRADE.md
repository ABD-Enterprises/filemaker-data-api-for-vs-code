# Upgrade Guide

What to do, and what will look different, when you move from one version to the next. Each section lists only changes you can notice. For everything else, see the [Changelog](./CHANGELOG.md).

## Unreleased

The Record Editor now warns before saving or creating text with a NUL character (U+0000). On the FileMaker server we tested, FileMaker kept only the text before this character and dropped the rest. Choose **Remove the character and continue** to keep the text on both sides, or **Cancel**. Batch update/import refuses the whole affected row and reports why; AI writes refuse the value too. Other characters are left alone.

Layouts listing a field twice now generate types that compile. The editor shows one value with a note, while Layout Inspector keeps both occurrences.

A no-match find was verified on a real server (FileMaker Data API Engine, 2026-10-21): HTTP **200**, message code **401**, and an empty data list. Found and returned counts are zero. Older/other versions may use another status, so the extension keeps accepting code 401 on any HTTP status. Creating related portal records remains a known gap; this extension sends only the main record's fields.

## Upgrading from 1.5.0 to 1.6.0

This is a minor release. Your profiles, saved queries, settings and stored data carry over unchanged, and no command or setting was removed or renamed. Nothing needs to be done for a normal install. These are the behavior changes you may notice.

### 1. Fields look the same everywhere, and Layout Mode can tidy a layout

The find form, Record Editor, Record Viewer and the generated web layout views now use the same field sizes, top labels and responsive spacing as Layout Mode. Your data and layouts are not changed, but these screens will look different from 1.5.0.

Layout Mode adds standard field sizes and spacing, an action that arranges the selected objects into a standard form, an action that standardizes them, and starter templates (blank, form, two-column, first portal; the templates are offered for a new, empty web layout). Arranging and standardizing each undo in one step. Nothing is rearranged until you choose an action; field names and behavior bindings stay as they are. Layout Mode now lists fields in FileMaker's field order instead of alphabetically.

**Apps you generated before:** the next time you run **Generate FM Web Next.js App** or **Start FM Web Preview Server**, the extension refreshes the managed runtime files in an app you generated earlier (template version 2 becomes 3: `page.tsx`, `bridge-client.ts`, `runtime-data.ts`, `runtime-behavior.ts` and `runtime-layout-client.tsx`). A managed file you edited is not overwritten: a warning names it, and you delete that file and run the command again to get a fresh copy; until then the preview cannot reach the bridge.

### 2. Trusted certificates work without changing a VS Code setting

Trusting a server's certificate now works with every value of VS Code's **http.proxySupport** setting, including its default, `override`. The extension checks the trusted fingerprint itself on every connection. A different certificate is refused before a password or request body is sent, even if it is otherwise publicly trusted. CA-file-only profiles keep their existing certificate handling, including environment, VS Code and system/PAC proxy routing; they already worked with `override`. Profiles with the older **Allow self-signed** setting now go direct too when no environment proxy applies, preserving that setting under the host patch. Behind an environment proxy they keep the previous proxy CONNECT tunnel, where VS Code may still replace the agent and reject an untrusted certificate. The older setting skips every check when its agent is used, unless a trusted fingerprint is present, and still shows warnings.

A pinned connection must go directly to the server. If an environment proxy, VS Code proxy or system/PAC rule selects a proxy, the connection is refused with advice to exclude the server from that proxy. You do not need to change settings for a direct connection. The `PIN_THROUGH_PROXY` refusal also applies when a profile has both a pin and a CA file: the pin takes priority. A message suggesting `http.proxySupport` set to `fallback` is reserved for an untrusted pin/legacy request left on the environment-proxy route while the host patch is active; it never replaces a CA-only certificate error. Certificate errors retain their network code and trust actions.

### Smaller changes

- A script, layout or container field named `.` or `..` is refused before anything is sent, also in proxy mode.
- Copied TypeScript keeps a field named `__proto__`; copied proxy requests keep a trailing slash; copied API base paths stay as configured; curl output switches off bracket and brace expansion when needed.
- New files written by Write AI Context and new FM Web runtime files are readable by you only; a file that is replaced keeps its permissions.
- The Record Viewer also asks the server for the layout's field details at the same time as the record (when schema metadata is on); it is not added to the request history and a failure is ignored.
- The Output panel and **Show Effective Settings** warn when `ai.hiddenFields` is a string instead of a list.
- A profile changed in another VS Code window refreshes the connection status, the explorer and the AI tools within two seconds.

### Rolling back

Install the previous version from the Extensions view (**Install Specific Version...**) or from a [release](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases) (only tagged versions have one). Your data is not migrated, so nothing needs to be undone.

## Upgrading from 1.4.0 to 1.5.0

This is a minor release. Your profiles, saved queries, settings and stored data carry over unchanged, and no command or setting was removed or renamed. Nothing needs to be done for a normal install. These are the behavior changes you may notice.

### 1. Scripts run with a single request, and return only the script's answer

The extension now runs a script the way the Claris Data API Guide documents it: one `GET .../layouts/<layout>/script/<script>?script.param=<text>`. Before, it sent a `POST` that the Data API does not accept and then fell back to a find with the script attached, so every script run also read a record.

- A script run now reads no record. The result you get back is the script's result and error code only. If something you built (a Layout Mode `runScript` behavior, a plugin, an AI tool call) relied on the record data that used to come back with a script run, fetch the record with a find instead.
- A script parameter is sent percent-encoded exactly (a space is `%20`, never `+`). A parameter too long for a web address (about 2,000 characters) is sent in the body of a find limited to one record, which is the guide's other documented form. With a record ID and a parameter that long you get a clear error instead.
- A script or layout named `.` or `..` is refused with a message before anything is sent.
- **Copy as curl / fetch** in the Script Runner shows the same `GET` request.

### 2. Names are no longer trimmed

Layout, script and field names are now used exactly as the server lists them or as you typed them. A name with a leading or trailing space (for example ` Sales`) used to be turned into `Sales`, which could not be opened or, worse, pointed at a different layout. Layouts that differ only in spacing or case are now separate entries. Action: if you have a saved query, a generated type file or a snippet that was created for a layout whose name begins or ends with a space, check it still points where you expect. Names without such spaces are not affected.

### 3. `@filemaker` in the Chat view (new, off until you switch AI tools on)

VS Code's Chat view now lists a read-only `@filemaker` participant (`/layouts`, `/describe`, `/find`, `/explain`, `/help`). It reads the database only through the AI tools, so it does nothing until you turn those on (`filemaker.ai.enabled` and a connection chosen with **Set AI Access for Connection**; both are off by default), and it follows every AI setting, approval, limit, hidden-field rule and the kill switch. It has no command that changes a record or runs a script, even if you allowed writes and scripts for agent mode. In an untrusted workspace (Restricted Mode) it is listed but answers every request with "AI tools are not available right now" and reads nothing. It sends the language model only layout and field names and your own words, never record values or connection details. There is no new setting. See [Chat with @filemaker](./docs/USER_GUIDE.md#chat-with-filemaker).

### 4. Copy a request as code

**Copy request** in the Query Builder and Script Runner now offers curl, `fetch()`, a `.http` file (for the REST Client extension), a Postman collection and TypeScript, and the Record Viewer and Record Editor have **Copy request for this record**. A new command, **FileMaker: Copy Request as Code…**, copies a request for the active connection. Your password, session token and API key are never copied. The existing setting `filemaker.snippets.includeAuthByDefault` (default off) now covers all of these: with it on, copied requests show an `Authorization` header with a variable to fill in (for example `$FM_TOKEN`) instead of `<REDACTED>`. See [Copy a request as code](./docs/USER_GUIDE.md#copy-a-request-as-code).

### Smaller changes

- **Panels fit narrow editors.** Long layout names are clipped (full name in the tooltip) instead of widening the page; the Query Builder, Diagnostics and Layout Mode work from 360 px wide.
- **Record Editor and Record Viewer.** The editor says when fields are not shown because your account cannot access them, and names fields the record has no value for. The viewer loads the record it was opened for, or shows a hint when opened without one.
- **Connection wizard** shows a notice when the workspace is in Restricted Mode, with a **Manage Workspace Trust** button.
- **Refresh Schema Cache** also clears the layout list, so the next refresh reads layouts from the server again.
- A connection that drops while a reply is still arriving is reported as incomplete, not as a success.
- **Windows and Linux.** Updating a file marked read-only (Write AI Context, the FM Web runtime) works on Windows; the MCP shim waits longer for PowerShell; folder paths from MCP clients match regardless of letter case on Windows.
- Logs and diagnostics hide more secrets (single-quoted keys; `Cookie`, `Set-Cookie`, `Authorization` and `Proxy-Authorization` lines), and configured file paths now reject characters that render as blank.
- A badly formed `filemaker.ai.hiddenFields` value no longer switches hiding off: the valid names still hide.

### Rolling back

Install the previous version from the Extensions view (**Install Specific Version...**) or from a [release](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases) (only tagged versions have one). Your data is not migrated, so nothing needs to be undone.

## Upgrading from 1.3.0 to 1.4.0

This is a minor release. Your profiles, saved queries, settings and stored data carry over unchanged, and no command or setting was removed. Nothing needs to be done for a normal install. These are the behavior changes you may notice, and what to do about each.

### 1. A repository file can no longer grant a role or switch protections off

A workspace `.vscode/settings.json` or `.vscode/filemaker.config.json` can make the extension stricter. It can no longer loosen anything you set in your own user settings:

| Setting or file | A workspace can still | A workspace can no longer |
| --- | --- | --- |
| `filemaker.enterprise.mode`, `enterpriseMode` in `filemaker.config.json` | turn enterprise mode on | turn it off |
| `filemaker.enterprise.role`, `role` in `filemaker.config.json` | lower the role | raise it above your own user setting (default `developer`) |
| `filemaker.offline.mode` | turn offline mode on | turn it off |
| `filemaker.features.*.enabled` | turn a feature off | turn a feature on |

Action: if you relied on a repository file to grant `admin`, to switch enterprise mode off or to switch a feature back on, set it in your **user** settings instead. `filemaker.secrets.fallback` and `filemaker.export.neutralizeFormulas` are read from user settings only too, and several settings are ignored in an untrusted workspace (see the settings reference).

**Toggle Offline Mode** now changes your user setting and reports the mode that is really in effect. A workspace `offline.mode: true` written by an older version stays on and the command says so; edit that workspace setting yourself.

### 2. Generated file names with spaces or punctuation have a hash suffix

A layout whose name has anything besides letters, digits, `_`, `.` and `-` now gets `<safe name>-<8 characters>.ts` under `<typegen output>/layouts/`. Layouts that used to collide on one file now get separate files. Action: regenerate, update imports, and delete the old generated files. Names are also escaped inside the generated code. Layout names containing `..` (for example `Q1..Q2`) work in snapshots and the offline cache.

### 3. CSV and Copy as table apostrophes

CSV exports (batch export and Query Builder) and **Copy results as table** put a leading apostrophe in front of text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return, for example `'=SUM(A1)`. Plain numbers and phone numbers are not changed. Action: if another program reads these files, strip a leading apostrophe there, or set `filemaker.export.neutralizeFormulas` to `false` in your user settings (JSON Lines exports never had it). Batch update skips the `recordId` and `modId` columns, so a CSV export of a layout with plain fields can be edited and imported back. Exports also contain related (`Table::Field`), calculation, summary and container columns, and import sends every column back: delete those columns before importing, and do not expect an export to restore old values for layouts that have them.

### 4. New prompts

You will now be asked before:

- running a **workspace plugin** (`.vscode/filemaker-plugins/`). The whole folder is hashed and the approval is remembered per workspace and content, so plugins you already use ask once. A folder with more than 500 files, more than 20 MB or a symbolic link is refused.
- **Start FM Web Preview Server** runs `npm install` and `npm run dev`.
- a Layout Mode **`runScript`** behavior runs a script.
- the connection wizard saves or tests credentials against an **address that came from `.filemaker/profile-template.json`**, or sends them to a remote **`http://`** address.
- you change a saved profile's **server address, proxy address or user name**: type the password (or API key) again. **Test Connection** uses a throwaway session and never touches the saved secrets.
- switching AI tools back on, and every AI write.

### 5. AI features are off by default

New commands (**Write AI Context**, **Set AI Access for Connection**, **Show AI Activity**, **Start New AI Session**, **Switch AI Tools Off or On**, **Start/Stop AI Server for External Tools**, **Copy MCP Config for Claude Code / Cursor**) and `filemaker.ai.*` settings. Profiles gain an optional `aiAccess` (`none` by default), which resets to none if you change the profile's server, user, database or API paths. Nothing is read by an AI tool until you set `filemaker.ai.enabled` in your user settings and choose a connection. A status bar item `AI: off` is shown on the right; selecting it explains why AI is unavailable, or asks before switching tools back on if you used the kill switch. Older extension versions drop the unknown `ai` entry from `disabledFeatures`; use `filemaker.features.ai.enabled` in the same files if a team still has older versions.

### 6. Create Record works; Delete Record needs the record-edit switches

The Record Editor's create mode lists the layout's fields, has a **Create Record** button and a confirmation, and shows the new record's ID. Editing, creating, deleting and uploading, and the Script Runner, now need a trusted workspace. **Delete Record** now also respects `filemaker.features.recordEdit.enabled` and the enterprise record-edit restriction, like saving does. Saving a record whose version changed since you loaded it is refused (error 306) and your edits stay in the form.

### 7. The FM Web live preview is not in the Marketplace build

The Marketplace package does not include the preview app template, so **Start FM Web Preview Server** and **Generate FM Web Next.js App** are hidden from the Command Palette (invoked another way they say "not available in this installation") and need the repository. Layout Mode and metadata sync are unchanged. For repository users the preview now sends its bridge token, and previously generated apps get their managed files refreshed (an edited copy is left alone with a warning).

### 8. Other behavior to know about

- A server address with a user name or password in it (`https://user:pass@host`) is rejected. A saved profile that has one stays in the list so you can fix it.
- `.filemaker/profile-template.json` is ignored in an untrusted workspace and no longer locks the server address (only the database and API paths).
- `filemaker.typegen.outputDir` is ignored in untrusted workspaces and rejects drive-relative paths such as `D:folder`.
- For repository users of the FM Web preview, the bridge enforces your limits: record changes and script runs follow offline mode, the record-edit and script-runner switches, and the enterprise role.
- A Layout Mode `runScript` behavior needs a trusted workspace, the script runner on, offline mode off and a policy that allows scripts, and it asks for confirmation naming the script, parameter and connection.
- Enterprise `disabledFeatures` and role handling are restrict-only (see section 1).

### Smaller changes

- A find that matches nothing returns an empty result instead of an error.
- Parallel requests share one session renewal.
- Logs and error details hide more secrets.
- **Certificates.** The wizard shows a server's certificate (subject, issuer, names, dates, SHA-256) and, if you agree, trusts exactly that certificate for the connection (a pinned fingerprint stored in the profile, never from a workspace file). A different certificate later fails with **Review and re-trust**; an expired pinned certificate is refused unless you accepted that in the dialog; a pinned connection is never made through an HTTP proxy (exclude the server from the environment, VS Code or system proxy). A custom CA file under **Certificates (advanced)** is added to your computer's certificates. FileMaker Server's default certificate has no host names, so it needs the trust dialog, not a CA file. A pin is trust on first use of one fingerprint: compare it with your administrator's before you trust it; it detects a later change but does not prove who presented the certificate the first time. No released version had an "Allow self-signed certificate" checkbox, so nothing to migrate from 1.3.0; profiles that already carry the older hand-edited `allowSelfSigned` keep working with a persistent warning and an offer to convert. Pins work on direct routes with all four `http.proxySupport` values, including `override`, and refuse a required proxy with `PIN_THROUGH_PROXY`. CA-only profiles retain their previous certificate handling and proxy routing. The older `allowSelfSigned` goes direct when no environment proxy applies and skips every check when its agent is used; behind an environment proxy its previous CONNECT route and possible host-agent replacement are unchanged. A trusted fingerprint takes priority over both a CA file and the older flag.
- **Passwords and sign-in.** After FileMaker rejects the saved account or password (error 210 to 214, or 1703) the extension no longer signs in again by itself; edit the connection, or run **Connect** or **Test Connection**, to resume. With no free Data API sessions (956) automatic sign-ins back off from 30 seconds to 5 minutes. A rejected sign-in on a FileMaker Cloud host says Cloud uses a Claris ID, which the extension does not support (whether a tenant also accepts an account name and password is not confirmed).
- **Clearer errors.** Connection failures say what happened and what to do; a reply that is not Data API JSON gets its own message; redirects are not followed; "no records" is recognised by FileMaker code 401 (verified as HTTP 200 with empty data on a real FileMaker Data API Engine, 2026-10-21; older/other versions may use another status, so any status with code 401 stays accepted); a script error returned with a saved, created or deleted record is shown next to the success.
- **Test Connection** is a ladder (Data API and certificate, database list, sign-in) and the status bar shows the real state of the last request.
- **Batch update** carries on past records your account cannot change (error 200) and stops only when the account cannot update at all (9, 205, 207 or rejected credentials).
- **Settings:** every setting description starts with one of three badges, and **FileMaker: Show Effective Settings** shows the value in effect and why a workspace value is ignored. Nothing was renamed and no enforcement changed.
- **About / Show Version** shows the version and build, with **Copy for bug report**.
- Virtual workspaces (such as github.dev) are not supported.
- Release builds ship minified code without source maps (they are attached to each GitHub release), and `THIRD_PARTY_NOTICES.txt` is included.

### Rolling back

Install the previous version from the Extensions view (**Install Specific Version...**) or from a [release](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases) (only tagged versions have one). Your data is not migrated, so nothing needs to be undone, except the renamed generated files (regenerate them) and the `aiAccess` field (older versions ignore it).

## v1.2.0 to v1.3.0

- The unused `filemaker.telemetry.enabled` setting was removed. The extension has never collected telemetry. Delete the setting from your settings files; it did nothing.
- Published under the **SureForgeTech** publisher: the extension ID is `SureForgeTech.filemaker-data-api-tools`. If you install from the command line or list it in `.vscode/extensions.json`, use that ID.
- Webview Content Security Policy nonces use the operating system's random number generator.

## v1.1.0 to v1.2.0

- Settings were grouped. Old `filemakerDataApiTools.*` names (`logLevel`, `requestTimeoutMs`, `defaultApiBasePath`, `defaultApiVersionPath`) still work but are deprecated in favor of `filemaker.logging.level`, `filemaker.requestTimeoutMs`, `filemaker.defaultApiBasePath` and `filemaker.defaultApiVersionPath`. A more specific value wins whichever name it uses. A one-click migration is offered. A hand-edited non-string value for a path setting falls back to the default.
- **Export Connection Profiles** and **Import Connection Profiles** were removed. They never worked. Share a [profile template](./docs/USER_GUIDE.md#profile-templates-for-a-team) and saved queries instead.
- Query Builder paging uses FileMaker's 1-based offsets: **Start at record** 1 is the first record.
- Commands moved to a `FileMaker` category with clearer titles, so search for the new title in the Command Palette.

## v1.0.0 to v1.1.0

- The connection wizard replaces the old quick-pick flow. Existing profiles work without change.
- Many commands are hidden from the Command Palette until they apply (a profile exists, a snapshot exists, enterprise mode or `filemaker.advanced.powerUserMode` is on). Nothing was removed.
- Legacy `filemakerDataApiTools.*` settings were deprecated in favor of `filemaker.*`.
- A first-run walkthrough opens once.

## v0.9.0 to v1.0.0

Production release. No breaking changes.

## Older versions

For 0.x, see the [Changelog](./CHANGELOG.md).
