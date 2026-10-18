# FileMaker Data API Tools

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink)](https://github.com/sponsors/deffenda)

FileMaker Data API Tools turns VS Code into a serious FileMaker workspace: connect to a FileMaker server, inspect layouts and metadata, run find requests, edit records, compare schema snapshots, export large result sets, and review diagnostics without leaving the editor.

**Built by [ABD Enterprises](https://abdenterprises.com?ref=vscode).** A free, open-source tool for FileMaker developers — distilled from the workflows we use on every client engagement.

Built for teams that already live in VS Code:

- Direct and proxy connection modes
- Visual query builder plus raw JSON find requests
- Full CRUD workflows for records
- Schema snapshots, diffing, and generated TypeScript types
- Batch export/update jobs and request history
- Enterprise controls, offline metadata mode, and safe plugin hooks
- No telemetry and no required cloud account

## Product Tour

![Explorer overview](docs/marketplace/explorer-overview.png)

The explorer keeps profiles, layouts, saved queries, schema snapshots, request history, environment sets, and diagnostics in one sidebar workflow.

![Query builder](docs/marketplace/query-builder.png)

The query builder gives you a readable UI for FileMaker find payloads, saved queries, result previews, and export actions.

![Schema diff and batch tooling](docs/marketplace/schema-and-batch.png)

Capture schema snapshots, review drift between environments, and run batch exports with job status and diagnostics built in.

## Install

### From the VS Code Marketplace

1. Open the Extensions view in VS Code.
2. Search for `FileMaker Data API Tools`.
3. Select **Install**.
4. Reload the window if VS Code prompts you.

### From a VSIX

1. Download `filemaker-data-api-tools-1.0.0.vsix`.
2. Run **Extensions: Install from VSIX...** from the Command Palette.
3. Select the VSIX file and reload the window.

## Quick Start

### Connect with direct mode

1. Run **FileMaker: Add Connection Profile**.
2. Choose a profile name such as `Dev Server`.
3. Select **Direct**.
4. Enter the FileMaker server URL, database name, and credentials.
5. Run **FileMaker: Connect**.

Credentials stay in VS Code `SecretStorage`; they are never written to workspace settings or logs.

### Connect with proxy mode

1. Run **FileMaker: Add Connection Profile**.
2. Select **Proxy**.
3. Enter the FileMaker server URL, database name, and your proxy endpoint.
4. Add an API key if your proxy requires one.
5. Run **FileMaker: Connect**.

### Run your first query

1. Run **FileMaker: Open Query Builder**.
2. Pick a layout.
3. Add one or more find requests.
4. Click **Run Find**.
5. Review the result table or export the result set.

## Feature Highlights

### Query, records, and scripts

- Run FileMaker find requests with JSON or the visual query builder
- Open, create, edit, and delete records from within VS Code
- Save reusable queries and execute them from the explorer
- Run FileMaker scripts with parameters and inspect results

### Schema and generation

- Browse layout fields and value lists in the explorer
- Capture schema snapshots and diff drift over time
- Compare layouts across environments
- Generate TypeScript types and snippets from layout metadata

### Scale and operations

- Export large result sets to JSONL or CSV
- Run batch update jobs with dry-run defaults
- Review request history, latency, re-auth events, and diagnostics
- Use offline metadata mode when a server is unavailable

### Security and governance

- Secrets stored only in VS Code `SecretStorage`
- Authorization headers and credentials are redacted in logs and copy-as helpers
- Workspace trust and role guards protect write workflows
- Webviews use CSP nonces and do not call FileMaker endpoints directly

## AI tools

Off by default. Turn on `filemaker.ai.enabled` in your **user** settings (a workspace setting cannot), pick a connection with **FileMaker: Set AI Access for Connection**, and AI tools in VS Code (for example Copilot agent mode) can list layouts and scripts, describe a layout, find and read records, and explain error codes. With `filemaker.ai.allowWrites` they can also create, edit and delete one record at a time, and with `filemaker.ai.allowScripts` run scripts you put on `filemaker.ai.scriptAllowlist`.

What protects you, and what does not:

- **Read-only first.** Write and script tools are not offered until you switch them on. A connection has to be set to AI access "read" or "write" first. The status bar shows the effective state for the chosen connection.
- **You approve.** The first read of each layout asks once per session (at most 20 layouts a session). Every write asks in a dialog that VS Code cannot set to "always allow". A write is limited to 10 fields and 200 characters per value so the dialog can show every field name and every new value in full; anything larger is refused. A long old value is shown cut, with the number of characters left out. Delete asks you to type the record id. A record changed in the meantime is not overwritten, and if you switch AI off while a dialog is open, nothing is sent. A call whose values already match the record writes nothing and asks nothing; it still counts one record against the read quota.
- **Limits.** 50 records per call and 500 per session (reserved before the request is sent, so parallel calls cannot exceed it), 30 calls per minute, 10 write attempts per session and 3 per minute (a declined attempt counts). Switching the kill switch off and on does not reset these; **FileMaker: Start New AI Session** does, after asking you. The status bar item shows the state; one click switches everything off, and switching back on asks you. **FileMaker: Show AI Activity** lists what was done (no field values).
- **Use a restricted FileMaker account.** FileMaker privilege sets are the only control that does not depend on the AI model or on you. Connect with a dedicated account with a read-only privilege set.
- **Data goes to the model provider.** Anything a tool returns is sent to the AI model you chose, and can leave through any shell, web or git tool the same agent has. Field values and field names are text from your database; a hostile value or name can try to steer the agent. Container fields, container streaming URLs and the server address are left out of results; other text in a value is passed on.
- **Hidden fields are best effort.** `filemaker.ai.hiddenFields` hides fields by name (repetitions such as `Salary(2)` included). It does not stop disclosure through a calculation, a summary field or a script.
- **Keep policy in user settings.** A workspace file can be edited by an agent that has file-editing tools. Put `filemaker.ai.hiddenFields` and enterprise settings such as `filemaker.features.ai.enabled` in your **user** settings (or in an enterprise-managed location), not only in `.vscode/settings.json` or `.vscode/filemaker.config.json`. The `filemaker.ai.*` settings that widen access already ignore workspace values.
- **Tool names.** The tools are called `fm_list_layouts`, `fm_find_records` and so on. VS Code tool names share one namespace across extensions, so another extension that registers the same name would conflict; the prefix `fm_` makes that unlikely, and it was not changed because the names are part of ADR-0004.

See `docs/DATA_HANDLING.md` and ADR-0004 for the full list.

## Common Commands

| Command | Purpose |
| --- | --- |
| `FileMaker: Add Connection Profile` | Create a new direct or proxy connection |
| `FileMaker: Connect` | Start a session with a saved profile |
| `FileMaker: Open Query Builder` | Build and run FileMaker find requests |
| `FileMaker: Open Record Editor` | Edit a record with preview support |
| `FileMaker: Create Record` | Create a new record on a layout |
| `FileMaker: Delete Record` | Delete a record with confirmation |
| `FileMaker: Upload to Container` | Upload an image, PDF, or binary file to a container field |
| `FileMaker: Capture Schema Snapshot` | Save metadata for later diffing |
| `FileMaker: Diff Schema Snapshots` | Compare two snapshots side by side |
| `FileMaker: Batch Export (Find)` | Export JSONL or CSV from a find request |
| `FileMaker: Show Request History` | Review prior API requests and status |

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run package:check
```

`npm run package:check` produces a VSIX in `artifacts/` using the same metadata and image URLs that the Marketplace pipeline uses.

Additional project docs:

- [User Guide](./docs/USER_GUIDE.md)
- [Compatibility](./docs/COMPATIBILITY.md)
- [Architecture](./ARCHITECTURE.md)
- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
- [Upgrade Guide](./UPGRADE.md)
- [QA Smoke Test (v1.1.0)](./docs/QA/SMOKE_TEST_v1_1_0.md) — manual first-time-user test plan for release validation

## Need help with FileMaker integration?

This extension is free and MIT-licensed. The team behind it — [ABD Enterprises](https://abdenterprises.com?ref=vscode) — has been delivering FileMaker integration, migration, and modernization work since 2005.

If you need a hand with the work behind the tool:

| Engagement | Price | What you get |
| --- | --- | --- |
| **Discovery Sprint** | $3,000 / 1 week | Documented requirements + effort estimate |
| **Integration Audit** | $4,500 / 1 week | Architecture review, gap analysis, prioritized remediation |
| **Migration Assessment** | $9,000 / 2 weeks | Honest evaluation: modernize within FileMaker, or move on |
| **Platform Modernization** | $25k – $150k | Execute the chosen path in measured phases |
| **Retainer** | $5,000 / month | Ongoing maintenance, feature work, FM Server administration |

**Contact:** [registrar@abdenterprises.com](mailto:registrar@abdenterprises.com?subject=From%20VS%20Code%20Extension) · [abdenterprises.com](https://abdenterprises.com?ref=vscode)

## License

MIT
