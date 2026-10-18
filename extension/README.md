# FileMaker Data API Tools

Work with a FileMaker database from VS Code: connect to a server, inspect layouts, run finds, edit records, compare schema snapshots, export large result sets, generate TypeScript types, and review diagnostics without leaving the editor.

**Built by [ABD Enterprises](https://abdenterprises.com?ref=vscode).** Free, open source (MIT), no telemetry, no cloud account.

## What it does

- **Connect** directly to the FileMaker Data API or through your own proxy. Passwords stay in your operating system keychain.
- **Find** with a visual query builder or raw JSON, and page, sort and export the results.
- **Edit** records (create, update, delete, container upload). If someone else changed a record, your save is refused instead of overwriting theirs.
- **Run scripts** with parameters and see the result.
- **Track schema**: capture snapshots, diff them, compare environments, and generate TypeScript types, a typed client and editor snippets.
- **Batch**: export to JSONL or CSV, or update many records from a CSV or JSON file, with a dry run first.
- **Control**: workspace trust, an enterprise mode with roles, an offline metadata mode, and confirmation before risky actions.
- **AI, off by default**: give AI coding tools your real layout names, and optionally let an agent read, and with your approval change, records.

## Product tour

![Explorer overview](docs/marketplace/explorer-overview.png)

The sidebar keeps connections, layouts, fields, saved queries, schema snapshots and jobs in one place.

![Query builder](docs/marketplace/query-builder.png)

The query builder gives you a readable form for FileMaker find requests, with a JSON view, saved queries and export.

![Schema diff and batch tooling](docs/marketplace/schema-and-batch.png)

Capture schema snapshots, review drift between environments, and run batch exports with job status.

## Requirements

- FileMaker Server (or FileMaker Cloud) with the **Data API** enabled, reachable over HTTPS.
- A FileMaker account whose privilege set has the **`fmrest`** extended privilege.
- VS Code 1.96 or newer.

See [Compatibility](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/COMPATIBILITY.md) for tested server versions.

## Install

1. Open the Extensions view in VS Code.
2. Search for `FileMaker Data API Tools` (publisher SureForgeTech).
3. Select **Install**.

To install a specific version, download the `.vsix` from the [GitHub releases](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases) and run **Extensions: Install from VSIX...**.

## Quick start

1. Run **FileMaker: Add Connection Profile**. Choose **Direct** (server URL, database, account) or **Proxy** (server URL, database, proxy endpoint).
2. Select **Test Connection**, then **Save Profile**, then **Connect Now**.
3. Run **FileMaker: Open Query Builder**, pick a layout, add a condition and select **Run**.

For guided steps, run **FileMaker: Open Getting Started Walkthrough**. The full manual is the [User Guide](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/USER_GUIDE.md) (also in VS Code: **FileMaker: Open User Guide**).

## AI tools

Off by default. Turn on `filemaker.ai.enabled` in your **user** settings (a workspace setting cannot), pick a connection with **FileMaker: Set AI Access for Connection**, and AI tools in VS Code (for example Copilot agent mode) can list layouts and scripts, describe a layout, find and read records, and explain error codes. With `filemaker.ai.allowWrites` they can also create, edit and delete one record at a time, and with `filemaker.ai.allowScripts` run scripts you put on `filemaker.ai.scriptAllowlist`. **FileMaker: Write AI Context** writes a short file of layout, field and script names that AI coding tools can load.

What protects you, and what does not:

- **Read-only first.** Write and script tools are not offered until you switch them on, and the connection must be set to AI access "read" or "write". The status bar shows the state.
- **You approve.** The first read of each layout asks once per session (at most 20 layouts a session). Every write asks in a dialog that VS Code cannot set to "always allow". The dialog shows every field name and every new value in full, so a write is limited to 10 fields and 300 characters per value; anything larger is refused. A long old value is shown cut, with the number of characters left out. Delete asks you to type the record id. A record changed in the meantime is not overwritten, and if you switch AI off while a dialog is open, nothing is sent.
- **Limits.** 50 records per call and 500 per session, 30 calls per minute, 10 write attempts per session and 3 per minute (a declined attempt counts). Switching the kill switch off and on does not reset these; **FileMaker: Start New AI Session** does, after asking you. The status bar item is the kill switch. **FileMaker: Show AI Activity** lists what was done (no field values).
- **Use a restricted FileMaker account.** FileMaker privilege sets are the only control that does not depend on the AI model or on you. Connect with a dedicated account with a read-only privilege set.
- **Data goes to the model provider.** Anything a tool returns is sent to the AI model you chose, and can leave through any shell, web or git tool the same agent has. Field values and field names are text from your database; a hostile value or name can try to steer the agent. Container fields, container streaming URLs and the server address are left out of results; other text in a value is passed on.
- **Hidden fields are best effort.** `filemaker.ai.hiddenFields` hides fields by name (repetitions such as `Salary(2)` included). It does not stop disclosure through a calculation, a summary field or a script.
- **Keep policy in user settings.** A workspace file can be edited by an agent that has file-editing tools. Put `filemaker.ai.hiddenFields` and enterprise settings such as `filemaker.features.ai.enabled` in your **user** settings (or in an enterprise-managed location), not only in `.vscode/settings.json` or `.vscode/filemaker.config.json`. The `filemaker.ai.*` settings that widen access already ignore workspace values.
- **Tool names.** The tools are called `fm_list_layouts`, `fm_find_records` and so on. VS Code tool names share one namespace across extensions; the prefix `fm_` makes a clash unlikely.

Details: [Using AI with FileMaker](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/USER_GUIDE.md#using-ai-with-filemaker) and [Data handling](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/docs/DATA_HANDLING.md).

## Common commands

| Command | Purpose |
| --- | --- |
| `FileMaker: Add Connection Profile` | Create a direct or proxy connection |
| `FileMaker: Connect` | Start a session with a saved profile |
| `FileMaker: Open Query Builder` | Build and run find requests |
| `FileMaker: Open Record Editor` | Edit a record |
| `FileMaker: Create Record` | Create a record on a layout |
| `FileMaker: Delete Record` | Delete a record, with confirmation |
| `FileMaker: Open Script Runner` | Run a script with a parameter |
| `FileMaker: Capture Schema Snapshot` | Save layout metadata for later diffing |
| `FileMaker: Diff Schema Snapshots` | Compare two snapshots |
| `FileMaker: Generate Types for Layout` | Write a TypeScript interface for a layout |
| `FileMaker: Batch Export (Find)` | Export JSONL or CSV from a find |
| `FileMaker: Batch Update from CSV/JSON` | Update many records, dry run first |
| `FileMaker: Write AI Context` | Write layout, field and script names for AI tools |
| `FileMaker: Show Diagnostics` | Open a redacted report for bug reports |

## Security and privacy

- Passwords, API keys and session tokens live in VS Code SecretStorage (your OS keychain), not in settings or logs.
- Logs, history and error details hide authorization headers, tokens and passwords.
- Deleting records, uploading, batch jobs, writing generated files and plugins need a trusted workspace. A repository can make the extension's policy stricter but never looser.
- The extension collects no telemetry. It talks only to your FileMaker server or your proxy.

Read the [security overview](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/docs/security.md), the [data handling notes](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/docs/DATA_HANDLING.md), and the [security policy](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/SECURITY.md) for how to report a vulnerability.

## More

- [User Guide](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/USER_GUIDE.md)
- [Changelog](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/CHANGELOG.md) and [upgrade notes](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/UPGRADE.md)
- [Compatibility](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/COMPATIBILITY.md)
- [Report a bug or request a feature](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/issues)
- [Contributing](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/CONTRIBUTING.md) and [architecture](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/ARCHITECTURE.md)

## Need help with FileMaker integration?

This extension is free and MIT-licensed. [ABD Enterprises](https://abdenterprises.com?ref=vscode) has delivered FileMaker integration, migration and modernization work since 2005. Contact: [registrar@abdenterprises.com](mailto:registrar@abdenterprises.com?subject=From%20VS%20Code%20Extension).

## License

MIT
