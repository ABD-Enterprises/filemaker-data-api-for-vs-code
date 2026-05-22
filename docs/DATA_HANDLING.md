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
