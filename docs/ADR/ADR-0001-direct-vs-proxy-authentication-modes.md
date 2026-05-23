# ADR-0001: Direct vs Proxy Authentication Modes

## Status

Accepted

## Context

The extension needs to support users who can connect directly to FileMaker Server over HTTPS and teams that require a middleware layer between VS Code and FileMaker. Direct access is simpler for individual developers, but some organizations need network segmentation, centralized logging, additional authorization, or custom identity handling outside the extension.

At the same time, credentials must stay out of webviews, logs, settings files, and workspace files. The extension also needs a single command and explorer experience regardless of whether requests are sent directly to FileMaker or through middleware.

## Decision

The extension supports two explicit authentication modes on each connection profile:

- **Direct mode** sends FileMaker Data API requests from VS Code to the configured FileMaker Server. Passwords and session tokens are read through `SecretStore`, and session creation uses FileMaker username/password credentials.
- **Proxy mode** sends requests to a user-configured proxy endpoint. The proxy receives only the fields needed to route and authenticate against FileMaker: profile id, database, server URL, API base path, and API version path. Human-readable profile names are intentionally omitted from proxy payloads.

The command surface, tree views, query builder, record operations, and script operations use `FMClient` as the shared entry point. `FMClient` delegates proxy-mode calls to `ProxyClient` while preserving the same high-level behavior for callers.

## Consequences

- Users can choose the least complex mode that fits their network and security model.
- Proxy mode is an explicit trust boundary: a configured proxy can receive enough information to authenticate to FileMaker on the user's behalf.
- Direct mode remains usable without any additional service.
- Future identity flows, including organization-specific SSO, can be implemented behind a proxy without expanding the extension's credential model.
- Tests need to cover both direct and proxy behavior so feature additions do not accidentally bypass proxy mode.
