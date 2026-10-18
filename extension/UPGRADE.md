# Upgrade Guide

What to do, and what will look different, when you move from one version to the next. Each section lists only changes you can notice. For everything else, see the [Changelog](./CHANGELOG.md).

## v1.3.0 to v1.4.0

Nothing needs to be done for a normal install: profiles, saved queries and settings carry over. Read this list if you share settings through a repository, use enterprise mode, generate code, or consume exported CSV files.

### Policy from a repository is now restrict-only

A workspace `.vscode/settings.json` or `.vscode/filemaker.config.json` can make the extension stricter. It can no longer loosen anything you set in your own user settings.

| Setting or file | A workspace can still | A workspace can no longer |
| --- | --- | --- |
| `filemaker.enterprise.mode`, `enterpriseMode` in `filemaker.config.json` | turn enterprise mode on | turn it off |
| `filemaker.enterprise.role`, `role` in `filemaker.config.json` | lower the role | raise it above your own user setting (default `developer`) |
| `filemaker.offline.mode` | turn offline mode on | turn it off |
| `filemaker.features.*.enabled` | turn a feature off | turn a feature on |

Action if you relied on a repository file to grant `admin`, to switch enterprise mode off or to switch a feature back on: set that in your **user** settings instead. `filemaker.offline.mode` and `filemaker.features.ai.enabled` are also ignored in an untrusted workspace.

The **Toggle Offline Mode** command writes the workspace setting, so it needs an open folder and cannot turn offline mode off when your user settings turn it on. Change it in your user settings.

### New prompts

You will now be asked before:

- running a **workspace plugin** (`.vscode/filemaker-plugins/`). The whole folder is hashed, the approval is remembered per workspace and content, and any change asks again. A folder with more than 500 files or a symbolic link is refused. Plugins you relied on will ask once.
- **Start FM Web Preview Server** runs `npm install` and `npm run dev`.
- a Layout Mode **`runScript`** behavior runs a script (it also needs the script runner enabled, offline mode off and a policy that allows scripts).
- the connection wizard saves or tests credentials against an **address that came from `.filemaker/profile-template.json`**, or sends them to a remote **`http://`** address.
- switching AI tools back on, and every AI write (AI features are off by default).

### Connection wizard

- Changing the **server address, proxy address or user name** of a saved profile no longer reuses the saved password, API key or session token. Type the secret again. Changing only the name or the database keeps it.
- **Test Connection** uses a throwaway session and never reads, overwrites or clears a saved profile's secrets. For an unchanged server and user you can leave the password empty to test with the saved one.
- A server address with a user name or password inside it (`https://user:pass@host`) is rejected. A saved profile that has one stays in the list so you can fix it.
- `.filemaker/profile-template.json` is ignored in an untrusted workspace and no longer locks the server address (only the database, API base path and API version). Share the server address in the template, but expect everyone to see it on a banner and confirm it.

### Generated files and exports

- **Generated type, client and snippet file names changed** for layouts whose names contain spaces or punctuation: such a layout now gets `<safe name>-<8 characters>.ts` under `<typegen output>/layouts/`. Names made of letters, digits, `_`, `.` and `-` are unchanged. Layouts that used to collide on one file now get separate files. Action: regenerate, update imports, and delete the old files.
- **CSV exports** (batch export and Query Builder) put a leading apostrophe in front of text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return, for example `'=SUM(A1)`. Plain numbers and phone numbers are not changed. **Copy results as table** in the Query Builder does not get this protection. A CSV export is not a ready-made import file (it has `recordId` and `modId` columns and batch update reads `modId` as a field). Action: if another program reads these CSV files, strip a leading apostrophe there.
- Names that came from a database are escaped in generated TypeScript, so a layout named with `*/` can no longer put code in a file.
- `.vscode/filemaker/snapshots/` and the offline cache index are validated. Entries that are not plain `.json` file names in that folder are ignored.
- `filemaker.typegen.outputDir` rejects Windows drive-relative paths such as `D:folder` (it falls back to `filemaker-types`).

### Behavior that is different

- **Record Editor:** saving sends the version of the record you loaded. If the record changed, FileMaker refuses the edit (error 306), the editor shows what changed, and your edits stay in the form until you choose **Reload record**. Before, the last save silently won. Batch update is unchanged.
- **Empty results:** a find that matches nothing (FileMaker's HTTP 404 with error 401) or an offset past the last match returns an empty result. Scripts or notes that expected an error for "no records" need updating.
- **Session renewal:** parallel requests share one renewal when a session expires.
- **FM Web bridge:** record changes are refused in offline mode and when the enterprise role disallows `writeOperations`; script runs are refused in offline mode, when the script runner is switched off and when the role disallows `scriptRunner`. The bridge serves only the active connection. The preview app does not send the bridge's session token today, so its data calls are refused with HTTP 403.
- **Logs and details** hide more secrets (session tokens in request paths, more token-like query parameters and JSON keys, passwords inside URLs). If you grep logs for a value, it may now show as redacted.

### New, and off by default

- AI features: **Write AI Context**, language-model tools for VS Code agent mode, **Set AI Access for Connection**, **Show AI Activity**, **Start New AI Session**, and the `filemaker.ai.*` settings. Profiles gain an optional `aiAccess` of `none` (default), `read` or `write`. Nothing is read by an AI tool until you set `filemaker.ai.enabled` in your user settings and choose a connection.
- A status bar item `AI: off` on the right. It is the AI kill switch: selecting it turns AI tools off even when they were never on, and you are asked before they can be turned on again.
- Enterprise feature id `ai` for `disabledFeatures`, and the restrict-only setting `filemaker.features.ai.enabled`.
- Roles and enterprise files: older extension versions drop the unknown `ai` id from `disabledFeatures`. Use `filemaker.features.ai.enabled` in the same files if a team still has older versions.

### Rolling back

Install the previous version from the Extensions view (**Install Specific Version...**) or from a [release](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases). Your data is not migrated, so nothing needs to be undone, except the renamed generated files (regenerate them) and the `aiAccess` field (older versions ignore it).

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
