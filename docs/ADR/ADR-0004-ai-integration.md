# ADR-0004: AI integration (MCP server, VS Code tools, schema context)

- Status: Proposed
- Date: 2026-10-18

## Context

Operators now work with AI models inside VS Code (Copilot agent mode, Claude Code, Cursor and similar). Without help, a model guesses layout and field names, writes `_find` requests that FileMaker rejects, and has no safe way to read or change data. The extension already has what a model needs: connection profiles with secrets held in SecretStorage, a Data API client, schema metadata, a query builder, a record editor with edit-conflict protection, a type generator, and the policy layer hardened in #372 (restrict-only offline mode, feature switches and enterprise roles).

What is missing is a way for a model to use those pieces without the model, or text it reads, being able to bypass them.

## Decision

Build one AI-facing core in the extension host and expose it three ways. Ship in this order.

### Phase 1 — schema context (read-only, no model access to data)

A command **FileMaker: Write AI Context** that writes a compact, generated file (default `.vscode/filemaker/ai-context.md`; the user can point it at an `AGENTS.md`/`CLAUDE.md` section they own) from the cached layout schema:

- layouts, field names, types, repetitions, value lists, portals, related-table fields, script names;
- the connection's name and database, never its server address, user name or any credential;
- a size budget (default 20 KB, whole layouts dropped last-used-first, with a note saying so);
- a header saying it is generated, when, and from which profile.

Names from the database are untrusted text. They go through the same escaping as generated code (`safeText`), are length-capped, and sit inside a fenced block marked as data, so a layout named "Ignore previous instructions…" is data, not an instruction.

This is useful on its own and carries almost no risk, so it ships first.

### Phase 2 — a tool core, exposed as VS Code language-model tools

A single `AiToolService` in the extension host with these tools. Each has a JSON schema, a per-call timeout and a result-size cap.

| Tool | Effect | Default |
|---|---|---|
| `fm_list_layouts`, `fm_describe_layout`, `fm_list_scripts` | read schema | on |
| `fm_find_records` | read data; validated against the layout's real fields before sending | on |
| `fm_get_record` | read data | on |
| `fm_explain_error` | map a FileMaker code to cause and fix | on |
| `fm_edit_record`, `fm_create_record`, `fm_delete_record` | write | **off** |
| `fm_run_script` | run a script | **off** |

They are registered with `vscode.lm.registerTool` so Copilot Chat's agent mode can call them. Their behaviour is fixed by the rules below, which hold for every transport.

### Phase 3 — an MCP server for other clients

Claude Code, Cursor and others speak MCP, not the VS Code API. Secrets live in SecretStorage, which only the extension host can read, so the MCP process must not hold credentials. The design:

- the extension host serves the tool core on a loopback-only endpoint, reusing the pattern and the token/origin/rate-limit checks of `FmBridgeServer`;
- a small stdio shim (`fm-mcp`, shipped in the VSIX) translates MCP to that endpoint and reads the per-session token from a user-only file;
- where the editor supports registering an MCP server definition directly, use that instead of the shim.

The shim holds no connection secrets. If the extension host is not running, it returns "open VS Code" and nothing else.

### Rules that apply to every tool and transport

1. **Same policy as the user's own commands.** Every call goes through the checks from #372: trusted workspace, offline mode, `features.*.enabled`, enterprise role and `disabledFeatures`, all restrict-only. A repository can narrow what the model may do, never widen it.
2. **Read-only by default; writes are opt-in per connection.** A new setting `filemaker.ai.allowWrites` (user scope only, ignored from workspace settings) turns the write tools on. `fm_run_script` needs its own switch, `filemaker.ai.allowScripts`.
3. **Every write is confirmed by the user, in the editor, with the facts.** A modal names the connection, layout, record id, and the fields and old → new values (or the script and parameter). The model's own description of the change is shown separately and labelled as such. There is no "always allow". Edits send the record's `modId`, so a stale edit is refused (error 306).
4. **The model never sees a secret.** Tools take a connection by name; credentials, tokens and the server address stay in the host. All output passes through `redactValue`, and no tool returns profile fields beyond name and database.
5. **Bounded results.** Defaults: 50 records per find, 200 KB per result, 30 calls per minute and 10 writes per session. A found-count and a "truncated" flag are returned so the model knows when it is seeing part of the data.
6. **Field-level control.** `filemaker.ai.hiddenFields` (user scope) lists `layout.field` patterns that are never returned to a model; they come back as `[hidden]`. Intended for personal data and secrets in the database.
7. **Audit.** Every call is logged locally (tool, connection, layout, record ids, outcome, whether the user confirmed), with values redacted by default. A **Show AI Activity** view displays it.
8. **Per-session kill switch.** A status-bar item shows "AI: read-only" or "AI: writes on" and turns the tools off in one click.
9. **Workspace content is untrusted input to the model.** Layout files, project files, plugin output and database values can contain text aimed at the model. They are returned as data with a stable wrapper and never as instructions; no tool takes an action because a returned value said to. The confirmation in rule 3 is what stops an injected instruction from changing data.

## Threat model

| Threat | Mitigation |
|---|---|
| Prompt injection from a database value or a cloned repo makes the model edit, delete or run a script | Read-only by default; user-scope switches the repo cannot set; modal confirmation with real values; `modId` check; write and script rate caps |
| Model exfiltrates data it can read to an external service | Not fully preventable once data is in the model's context. Reduce exposure: bounded results, hidden fields, read-only connection option, audit view, and documentation that data read by a tool goes to the model provider |
| Model or a tool reads credentials | Credentials never leave the host; redaction on all output; MCP shim holds none |
| Another local process calls the endpoint | Loopback only, per-session token in a user-only file, origin and rate checks, as in `FmBridgeServer` |
| A tool is used to reach another server | A tool picks a saved connection by name only; no URL parameter; the endpoint serves only the active connection (as the preview bridge does since #372) |
| Oversized or hostile result freezes the host | Result caps, timeouts, bounded regexes in redaction (tested) |
| Production data changed by mistake | Per-connection "read-only for AI" flag, defaulting on for connections the user labels production |

## Consequences

- Phase 1 is a small, safe feature that improves answers immediately.
- Phases 2 and 3 add real capability and a real attack surface; the rules above are part of the feature, not hardening to do later, and each phase needs its own adversarial review before merge.
- Enterprise mode can disable the AI tools wholesale (`disabledFeatures`), and an organisation can lock `allowWrites` off.
- Data returned by a tool is sent to whichever model provider the user chose. The extension cannot control that and says so in the README and `docs/DATA_HANDLING.md`.

## Open questions

- Which editor API versions to target. `vscode.lm.registerTool` and the MCP server-definition API arrived in different VS Code releases, and the extension's engine is `^1.96.0`. Check the current API docs before committing to a floor; raise the engine only if needed, and keep Phase 1 and the shim path working without it.
- Whether `fm_find_records` should accept the extension's simplified query form in addition to raw Data API `query` arrays.
- Whether to offer a dry-run mode that returns what a write would change without sending it.
- Whether the audit log should be exportable for enterprise review.
