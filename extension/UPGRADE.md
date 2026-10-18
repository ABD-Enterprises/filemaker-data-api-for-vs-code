# Upgrade Guide

What to do, and what will look different, when you move from one version to the next. Each section lists only changes you can notice. For everything else, see the [Changelog](./CHANGELOG.md).

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

New commands (**Write AI Context**, **Set AI Access for Connection**, **Show AI Activity**, **Start New AI Session**, **Switch AI Tools Off or On**, **Start/Stop AI Server for External Tools**, **Copy MCP Config for Claude Code / Cursor**) and `filemaker.ai.*` settings. Profiles gain an optional `aiAccess` (`none` by default), which resets to none if you change the profile's server, user, database or API paths. Nothing is read by an AI tool until you set `filemaker.ai.enabled` in your user settings and choose a connection. A status bar item `AI: off` is shown on the right; selecting it when AI is off only explains why. Older extension versions drop the unknown `ai` entry from `disabledFeatures`; use `filemaker.features.ai.enabled` in the same files if a team still has older versions.

### 6. Create Record works; Delete Record needs the record-edit switches

The Record Editor's create mode lists the layout's fields, has a **Create Record** button and a confirmation, and shows the new record's ID. Editing, creating, deleting and uploading, and the Script Runner, now need a trusted workspace. **Delete Record** now also respects `filemaker.features.recordEdit.enabled` and the enterprise record-edit restriction, like saving does. Saving a record whose version changed since you loaded it is refused (error 306) and your edits stay in the form.

### 7. The FM Web live preview is not in the Marketplace build

The Marketplace package does not include the preview app template, so **Start FM Web Preview Server** and **Generate FM Web Next.js App** say "not available in this installation" and need the repository. Layout Mode and metadata sync are unchanged. For repository users the preview now sends its bridge token, and previously generated apps get their managed files refreshed (an edited copy is left alone with a warning).

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
- **Certificates.** The wizard shows a server's certificate (subject, issuer, names, dates, SHA-256) and, if you agree, trusts exactly that certificate for the connection (a pinned fingerprint stored in the profile, never from a workspace file). A different certificate later fails with **Review and re-trust**; an expired pinned certificate is refused unless you accepted that in the dialog; a pinned connection is never made through an HTTP proxy (add the server to `NO_PROXY`). A custom CA file under **Certificates (advanced)** is added to your computer's certificates. FileMaker Server's default certificate has no host names, so it needs the trust dialog, not a CA file. A pin is trust on first use of one fingerprint: compare it with your administrator's before you trust it; it detects a later change but does not prove who presented the certificate the first time. No released version had an "Allow self-signed certificate" checkbox, so nothing to migrate from 1.3.0; profiles that already carry the older hand-edited `allowSelfSigned` keep working with a persistent warning and an offer to convert.
- **Passwords and sign-in.** After FileMaker rejects the saved account or password (error 210 to 214) the extension no longer signs in again by itself; edit the connection, or run **Connect** or **Test Connection**, to resume. With no free Data API sessions (956) automatic sign-ins back off from 30 seconds to 5 minutes. A rejected sign-in on a FileMaker Cloud host says Cloud uses a Claris ID, which the extension does not support (whether a tenant also accepts an account name and password is not confirmed).
- **Clearer errors.** Connection failures say what happened and what to do; a reply that is not Data API JSON gets its own message; redirects are not followed; "no records" is recognised by FileMaker code 401 whatever the HTTP status; a script error returned with a saved, created or deleted record is shown next to the success.
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
