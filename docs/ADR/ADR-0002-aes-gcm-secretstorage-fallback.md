# ADR-0002: AES-256-GCM Fallback When VS Code SecretStorage Is Unavailable

## Status

Accepted

## Context

VS Code `SecretStorage` is the preferred storage mechanism for passwords, FileMaker session tokens, and proxy API keys. Some headless, remote-agent, or constrained environments can make `SecretStorage` unavailable or unreliable. Without a fallback, those environments cannot persist secrets across the workflows that require them.

Persisting plaintext secrets in settings, workspace files, or logs is not acceptable. Any fallback also needs to be opt-in so normal desktop users keep the stronger platform-backed `SecretStorage` path.

## Decision

`SecretStore` supports three fallback modes:

- `vscode-only`: default behavior; use VS Code `SecretStorage` and surface errors if it fails.
- `workspace-state`: encrypt secret values and store the encrypted envelopes in VS Code workspace state.
- `disabled`: do not persist secrets.

The workspace-state fallback uses AES-256-GCM with random salt, random IV, authentication tag, and a PBKDF2-derived key. The key material includes the VS Code machine id when provided, so encrypted fallback values are not intended to decrypt on a different machine. When `SecretStorage` succeeds again, prior fallback entries for that key are cleared.

## Consequences

- Desktop users continue to rely on VS Code `SecretStorage` by default.
- Remote or headless environments can opt in to a fallback without storing plaintext credentials.
- The fallback is still weaker than platform-backed secret storage because encrypted envelopes live in workspace state.
- Users and maintainers need clear privacy and security documentation explaining when the fallback can be used.
- Fallback failures must be logged without exposing the secret key or secret value.
