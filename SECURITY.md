# Security Policy

This is the policy for **FileMaker Data API Tools** (`SureForgeTech.filemaker-data-api-tools`). For how the extension protects credentials and data, see the [security overview](docs/security.md) and [data handling](docs/DATA_HANDLING.md).

## Supported versions

Security fixes ship in a new release of the latest version on the VS Code Marketplace. Older versions are not patched. See [release cadence](docs/RELEASE_CADENCE.md).

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

Report it privately in one of two ways:

1. **GitHub private vulnerability reporting (preferred).** Open this repository's **Security** tab, choose **Advisories**, then **Report a vulnerability**.
2. **Email** `alan@abdenterprises.com`.

If the advisory option is not available, email instead, or open a public issue that contains **no** details and asks a maintainer to enable private reporting.

Please include:

- the affected version and operating system
- reproduction steps or a proof of concept
- the expected impact
- any disclosure timeline you have in mind

## What to expect

- **Acknowledgment** within 48 hours.
- **Initial assessment** (impact, affected versions, remediation path) within 7 calendar days, when the report has enough detail to reproduce. If it does not, the timeline pauses until we have what we need.
- **Fix window:** a fix or mitigation within 90 days of acknowledgment for confirmed vulnerabilities. Issues that could expose credentials, session tokens or FileMaker data get a shorter, emergency patch window.
- **Coordinated disclosure:** please do not disclose publicly before a fix, a mitigation or an agreed date. We credit reporters when they ask and it is appropriate.

## Scope

In scope: the extension in this repository, including its webviews, the FM Web bridge and preview, the AI tools, the build and release workflows in `.github/workflows`, and anything that leaks credentials, runs code from untrusted workspace content, or bypasses a confirmation or policy check.

Out of scope: weaknesses in FileMaker Server itself (report them to Claris), a compromised machine or proxy host, and a user who chooses to give an AI tool access to a connection (see the [AI section of the security overview](docs/security.md#ai-features)).

## Threats the extension is built to handle

- credential leakage (profiles, tokens, API keys, logs)
- unsafe write operations and unconfirmed actions
- running code or taking decisions from an untrusted repository (settings, templates, plugins, generated runtime folders)
- sensitive data in logs, history and diagnostics
- webview message and script injection
- prompt injection through database content when AI features are used

## Safe harbor

Good-faith research that avoids privacy violations, service disruption, data destruction and public disclosure before remediation is authorized by the maintainers is welcome and will not be pursued.
