# Data Handling

This document maps where the extension stores data, whether it is encrypted by
the extension, and when it is deleted. It is intended for enterprise security
and compliance review.

## Data Inventory

| Data category | Examples | Location | Format | Encryption | Retention and deletion |
| --- | --- | --- | --- | --- | --- |
| Connection profiles | Profile id, display name, server URL, database, auth mode, username, API path, proxy endpoint | VS Code `globalState` under the extension profile store | JSON | Not encrypted by the extension. Profile objects must not contain passwords, session tokens, or proxy API keys. | Retained until the user deletes the profile or VS Code removes extension global state. Profile deletion also clears related saved queries and active-profile selection. |
| Credentials | FileMaker password, session token, proxy API key | VS Code `SecretStorage` by default; optional workspace-state fallback envelope when SecretStorage is unavailable and fallback mode is enabled | SecretStorage record or AES-256-GCM envelope with salt, IV, ciphertext, and auth tag | Encrypted at rest by the OS-backed SecretStorage provider, or by the extension's AES-256-GCM fallback envelope. | Deleted when the user deletes the profile. A successful SecretStorage write also removes any older fallback envelope for the same key. |
| Schema snapshots | Captured layout metadata, field metadata, script metadata, snapshot summaries | VS Code `workspaceState` by default; optionally `.vscode/filemaker/snapshots/` when workspace-file storage is configured and the workspace is trusted | JSON | Not encrypted by the extension. Schema metadata can reveal internal names and should be treated as internal project data. | Retained until explicitly pruned by the configured max snapshots per layout, deleted with workspace state, or removed with the workspace files. |
| Saved queries | Query name, profile id, database, layout, find JSON, sort JSON, limits, timestamps | VS Code `workspaceState` or `globalState`, selected by `filemaker.savedQueries.scope` | JSON | Not encrypted by the extension. | Retained until the user deletes the query, imports over it, deletes the related profile, or VS Code removes the selected state scope. |
| Cache | Runtime schema/layout metadata cache, in-flight request state | Extension host memory only | JavaScript objects | Not persisted. No at-rest encryption is applied because the data is not written to disk by the extension. | Cleared on extension host reload, process exit, profile invalidation, or TTL expiry. Schema cache TTL is bounded by `filemaker.schema.cacheTtlSeconds` and defaults to 300 seconds. |
| Offline metadata cache | Layout metadata (field names, types, value lists) the extension read while online, so it can be browsed in offline mode | `.vscode/filemaker/offline-metadata/` in the workspace (trusted workspaces only), with an `index.json` | JSON | Not encrypted by the extension. Reveals internal names; do not commit to a public repository. | Refreshed by **FileMaker: Refresh Offline Metadata Cache** and whenever metadata is read online; the index keeps at most 1,000 items. Deleted with the workspace files. |
| Plugin approvals | Which workspace plugin folders you approved (workspace path and SHA-256 of the folder contents) | VS Code `globalState` | JSON | Not encrypted; contains no secrets. | Kept until VS Code removes extension global state. A changed folder is asked about again. |
| Audit logs | AI tool activity: tool, connection, layout, record ids, outcome, whether you confirmed | `ai-audit.log` in the extension's global storage folder (outside the workspace) | Text lines | Not encrypted. Field values are not logged. Model-supplied text is escaped and length-limited. | Capped at 256 KB; reads and refusals are dropped before write entries. Shown by **FileMaker: Show AI Activity**. There is no other durable audit-log file: request history and metrics are bounded VS Code `workspaceState`, and output-channel messages are transient IDE logs. |

## Data Flow

```text
VS Code commands and webviews
        |
        v
Extension host services
        |
        +--> Connection profile metadata --> VS Code globalState
        |
        +--> Passwords, tokens, proxy keys --> SecretStorage
        |                                      or AES-256-GCM fallback envelope
        |
        +--> Saved queries -----------------> workspaceState or globalState
        |
        +--> Schema snapshots --------------> workspaceState
        |                                      or .vscode/filemaker/snapshots/
        |
        +--> Runtime caches ----------------> extension host memory only
        |
        +--> Offline metadata --------------> .vscode/filemaker/offline-metadata/
        |
        +--> Direct/proxy API requests -----> configured FileMaker Data API
                                               or configured proxy endpoint
```

## Deletion Behavior

- Deleting a connection profile removes the profile metadata, clears the active
  profile selection when applicable, deletes credentials for that profile, and
  removes saved queries tied to that profile.
- Clearing VS Code extension state or removing a workspace can remove
  workspace-scoped records such as saved queries, history, metrics, and default
  schema snapshots.
- Workspace-file schema snapshots live in `.vscode/filemaker/snapshots/` and
  should be deleted from the workspace when the project no longer needs them.
- Offline metadata cache files live in `.vscode/filemaker/offline-metadata/` and are deleted with the workspace files.
- The AI activity log and generated AI context file (default location) live in the extension's storage folder; removing the extension's global storage removes them.
- In-memory caches do not survive extension host restart or VS Code reload.

## Security Notes

- Secrets must stay out of profile metadata, saved queries, schema snapshots,
  diagnostics, request history, and logs.
- Schema snapshots and saved queries are not encrypted. Treat exported or
  workspace-file copies as internal project artifacts.
- The extension sends API requests only to the configured FileMaker server or
  proxy endpoint for the active profile.

## AI Context File

**FileMaker: Write AI Context** writes a Markdown file with database structure:
the connection name, database name, and the layout, field and script names you
select. It contains no record data, value-list values, field descriptions,
server address, user name or credentials.

- It is written to the extension's storage folder by default, outside any
  repository. If you copy it into a workspace or point
  `filemaker.ai.contextPath` there, treat it as an internal project artifact and
  keep it out of public repositories.
- Names come from the database. Names are filtered (letters, digits, space and
  `_ - . : ( )`, 64 characters) and shown as JSON strings, but a name made only
  of allowed characters can still read like an instruction. An AI agent that
  loads the file can be influenced by it.
- Anything an AI tool reads, including this file, goes to the model provider
  you chose. The extension cannot control what that provider or the tool's other
  capabilities do with it.

## AI Tools

With `filemaker.ai.enabled` on (user settings only), language-model tools in VS Code can read the layouts, fields, scripts and records of the connection you chose, and with further switches change them (ADR-0004).

- **Data returned by a tool goes to the model provider you use.** The extension cannot control what the provider, or any shell, fetch or git tool the same agent has, does with it. Layout approval, the 500-record session quota and the 200 KB result cap reduce exposure; they do not remove it.
- **Field values and names are an uncontrolled text channel.** Values come back as JSON strings; layout and script names pass an allowlist (letters, digits, space and `_ - . : ( )`, 64 characters). Field names the model must send back unchanged are returned as they are (unless they contain control or separator characters), so a hostile field name can reach the model.
- **What is left out of results:** container fields, container streaming URLs and any value that points at the server's data API path (omitted), the server's own address, host and user name (replaced), secrets that match the redaction patterns, and IP addresses, absolute file paths and host names in error text. Other text in a value is passed on as it is.
- **The hidden-field filter is best effort.** `filemaker.ai.hiddenFields` matches by field name, case-insensitively, with or without a `Table::` prefix and with or without a repetition number such as `(2)`, on every layout. It cannot stop disclosure through a calculation or summary field on another layout, a script result, or a differently named field. A workspace file can add names but an agent with file-editing tools can edit workspace files, so keep your list, and enterprise settings, in user settings.
- **A restricted FileMaker account is the real control.** A dedicated account with a read-only privilege set is the only protection that does not depend on the model or on you.
- **Write dialogs show everything that is sent:** at most 10 fields, each new value up to 300 characters, all in full. A long old value is cut with a count. A write that cannot be shown this way is refused. The extension escapes control, bidirectional and markdown-significant characters in dialog text; the VS Code API documents `detail` only as "human-readable detail message" and does not say whether a modal renders markdown, so a bare web address in a value may still be linkified.
- The activity log is stored in the extension's storage folder, not the workspace, capped at 256 KB (reads and refusals are dropped before write entries). It records the tool, connection, layout, record ids, outcome and whether you confirmed. It does not record field values. Refused calls are logged at a limited rate.
- Secrets: tools never return the server address, user name or credentials; secrets in values and error text are redacted. Redaction can rewrite text in a field that looks like a secret, so writes refuse values containing the redaction marker.
