# Compatibility

This extension talks to FileMaker through the FileMaker Data API. A server is compatible when it exposes the standard Data API under `/fmi/data`, accepts HTTPS requests from your machine or proxy, and the target database account has the `fmrest` extended privilege enabled.

## Server Matrix

| Platform | Data API path | Status | Notes |
| --- | --- | --- | --- |
| FileMaker Server 19.x | `/fmi/data` | Supported, not continuously tested | Expected to work for core Data API workflows. Validate against your exact patch level before production use. |
| FileMaker Server 20.x | `/fmi/data` | Supported, not continuously tested | Expected to work for core Data API workflows. Validate scripts, container downloads, and value lists in your environment. |
| FileMaker Server 21.x | `/fmi/data` | Supported | Primary target for current extension behavior and release smoke testing. |
| FileMaker Cloud | `/fmi/data` | Untested | Expected to work when the Data API endpoint is reachable over HTTPS and credentials are accepted by FileMaker Cloud. Validate authentication and network policy before relying on it. |
| Custom proxy in front of FileMaker Server | Proxy-defined, upstream usually `/fmi/data` | Supported when compatible | Proxy mode expects the proxy to preserve FileMaker Data API request/response semantics and redact credentials from logs. |

No supported version is currently documented as known-broken. If you find a version-specific failure, open a bug report with the FileMaker Server version, operating system, deployment type, and Output panel logs.

## Feature Notes

| Feature | Compatibility note |
| --- | --- |
| Direct Data API sessions | Requires HTTPS reachability and an account with `fmrest`. The default API base path is `/fmi/data`. |
| Container fields | Container metadata and URLs are supported. Actual download behavior depends on server networking, SSL configuration, and whether returned container URLs are reachable from VS Code. |
| Value lists | Value list discovery depends on FileMaker layout metadata returned by the Data API. Layout-specific or privilege-filtered value lists may differ by account. |
| Scripts | Script listing and execution depend on the account's privileges and the script being available to the selected layout/database context. |
| OAuth / SSO | Direct mode currently uses FileMaker username/password credentials stored in VS Code SecretStorage. OAuth or SSO-specific flows are not implemented; use a compatible proxy if your organization requires custom identity handling. |
| Linux-hosted FileMaker Server | Expected to work when the standard Data API endpoint is enabled and reachable. Validate SSL certificates, firewall rules, and container URL reachability. |

## Version Selection Guidance

- Leave **API Base Path** set to `/fmi/data` unless your proxy or server deployment requires a custom route.
- Leave **API Version** set to `vLatest` unless you need to pin behavior for a specific server version.
- Test each saved profile after changing server version, credentials, proxy settings, SSL certificates, or firewall rules.
- Run the release smoke test against at least one representative server before rolling the extension out to a team.

## Reporting Gaps

Compatibility evidence is environment-specific. When reporting a gap, include:

- FileMaker Server or FileMaker Cloud version
- Server operating system and deployment type
- Extension version and VS Code version
- Direct mode or proxy mode
- The affected Data API operation
- Redacted Output panel logs
