# Privacy Policy

This policy describes how FileMaker Data API Tools handles data when installed as a VS Code extension.

## What The Extension Stores Locally

The extension stores configuration and workflow data through VS Code storage APIs:

- Connection profile metadata, including profile name, server URL, database name, API base path, API version, authentication mode, and proxy endpoint, is stored in VS Code extension state.
- The active profile id is stored in VS Code global state.
- Saved queries may be stored in VS Code workspace state or global state, depending on the configured saved-query scope.
- Schema snapshots, request history, request metrics, recent jobs, and environment sets are stored in workspace state or workspace files depending on the feature and configuration.
- Passwords, FileMaker session tokens, and proxy API keys are stored in VS Code `SecretStorage`.

If VS Code `SecretStorage` is unavailable and the user explicitly configures the `workspace-state` fallback, secrets are encrypted before being stored in workspace state. The default behavior is to use VS Code `SecretStorage`.

## What Is Not Collected Or Transmitted

The installed extension does not currently send analytics, product telemetry, crash reports, or usage events to ABD Enterprises or to a third-party analytics provider.

The extension does not intentionally transmit:

- FileMaker passwords to ABD Enterprises
- FileMaker session tokens to ABD Enterprises
- proxy API keys to ABD Enterprises
- database record contents to ABD Enterprises
- saved queries, schema snapshots, request history, or diagnostics to ABD Enterprises

Logs and diagnostics are generated locally. Sensitive keys and token-like values are redacted by extension helpers before they are shown in user-facing error details.

## Direct Mode

In direct mode, the extension connects from VS Code to the FileMaker Server URL configured by the user. Credentials are read locally from VS Code `SecretStorage` and sent only to the configured FileMaker Server endpoint for authentication and Data API requests.

## Proxy Mode

Proxy mode is an explicit opt-in path for teams that use their own middleware in front of FileMaker Server.

When proxy mode is enabled, the extension sends the minimum profile fields needed for routing and authentication to the configured proxy endpoint. This can include FileMaker connection details and credentials needed by the proxy to authenticate to FileMaker on the user's behalf. Users should only configure proxy endpoints they trust and operate under their own privacy and security controls.

## Third-Party Services

The installed extension contacts only services configured by the user:

- the FileMaker Server endpoint used in direct mode
- the user-configured middleware endpoint used in proxy mode

Repository automation may use GitHub Actions and Anthropic/Claude when maintainers enable the optional cloud agent workflow for issue implementation. That automation is separate from the installed VS Code extension and does not run in a user's editor.

## Telemetry Setting

The package currently declares a `filemaker.telemetry.enabled` setting with a default value of `false`. There is no active telemetry sender in the extension code at this time. If telemetry is implemented in the future, it should remain opt-in and be documented here before release.

## GDPR And CCPA

The extension is designed to avoid collecting personal information for ABD Enterprises. Because data stays local or goes only to user-configured FileMaker/proxy endpoints, privacy rights requests for data stored in a FileMaker database should be directed to the organization that operates that FileMaker Server or proxy.

For questions about this policy or data handled by the extension itself, contact alan@abdenterprises.com.

## Changes To This Policy

Privacy-impacting changes should be documented in this file and called out in release notes before publishing a new Marketplace version.
