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
| Audit logs | Future durable audit trail for extension actions, if added | No durable audit-log file exists today. Current diagnostics and request history use bounded VS Code `workspaceState`; output-channel messages are transient IDE logs. | JSON for bounded history and metrics; future audit logs should declare their file format when implemented | Current bounded history and metrics are not encrypted by the extension. Future appended audit logs should make encryption and redaction behavior explicit before release. | Current history and metrics are bounded and overwritten by max-entry settings. Future audit logs should define retention, rotation, deletion, and optional encryption before shipping. |

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
- **What is left out of results:** container fields, container streaming URLs and any value that points at the server's data API path (omitted), the server's own address and host (replaced; a user name is not removed from error text as a plain word), secrets that match the redaction patterns, and IP addresses, absolute file paths and host names in error text. Other text in a value is passed on as it is.
- **The hidden-field filter is best effort.** `filemaker.ai.hiddenFields` matches by field name, case-insensitively, with or without a `Table::` prefix and with or without a repetition number such as `(2)`, on every layout. It cannot stop disclosure through a calculation or summary field on another layout, a script result, or a differently named field. A workspace file can add names but an agent with file-editing tools can edit workspace files, so keep your list, and enterprise settings, in user settings.
- **A restricted FileMaker account is the real control.** A dedicated account with a read-only privilege set is the only protection that does not depend on the model or on you.
- **Write dialogs show everything that is sent:** at most 10 fields, each new value up to 200 characters, all in full. A long old value is cut with a count. The whole dialog text is also limited to 4,000 characters (escaped characters take extra room), because a native dialog can clip a longer one. A write that cannot be shown this way is refused. The extension escapes control, bidirectional and markdown-significant characters in dialog text; the VS Code API documents `detail` only as "human-readable detail message" and does not say whether a modal renders markdown, so a bare web address in a value may still be linkified.
- The activity log is stored in the extension's storage folder, not the workspace, capped at 256 KB (reads and refusals are dropped before write entries). It records the tool, connection, layout, record ids, outcome and whether you confirmed. It does not record field values. Refused calls are logged at a limited rate.
- Secrets: tools never put the server address, user name or credentials in results; secrets in values and error text are redacted. Redaction can rewrite text in a field that looks like a secret, so writes refuse values containing the redaction marker.

## AI Server for External Tools (MCP)

When you run **FileMaker: Start/Stop AI Server for External Tools** (and have `filemaker.ai.externalServer.enabled` on in your user settings), a local server in the VS Code window lets MCP clients such as Claude Code and Cursor call the AI tools described above.

- **Same rules, one implementation.** The server only passes `tools/list` and `tools/call` to the tool core; consent, caps, dialogs, hidden fields and the kill switch apply exactly as for VS Code's own agent mode. `tools/list` shows what the core offers at that moment.
- **Who can connect.** A Unix socket in a folder only you can use (mode 0700, socket 0600), or on Windows an unguessable named pipe. Windows gives a Node-created pipe no promise of a user-only access list, so every connection must also send a per-session 256-bit token in a first message; the token is kept in a discovery file (mode 0600) in the extension's storage folder and checked in constant time. The discovery file also names the VS Code process and its start time; the shim connects only if that process is alive and is the same run, so a stale file cannot send the token to another program. A program running as you can still read that file, as it can read anything else of yours.
- **Limits.** 1 MiB per message, 8 connections, 120 requests a minute per connection, 8 calls in flight per connection, idle connections closed after 15 minutes, and a 5 second limit to authenticate.
- **What the client name means.** The name an MCP client sends is its own claim and is only written to the activity log.
- **Data leaves for a different provider.** The model provider behind the MCP client is chosen in that client, not in VS Code. What a tool returns goes there.
- **Not supported:** remote windows (Dev Containers, Codespaces, SSH, WSL). The server will not start there.
- **Needs Node.js 18 or newer** on the PATH of the MCP client for the shim.

