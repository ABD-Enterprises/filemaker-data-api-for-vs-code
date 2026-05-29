# Security Policy

## Threat Model Summary

Primary risks addressed by this extension:
- credential leakage (profiles, tokens, API keys)
- unsafe write operations
- unsafe plugin execution in untrusted workspaces
- sensitive data exposure in logs/history/diagnostics
- webview message/script injection vectors

## Secret Handling

- Passwords/session tokens/proxy keys are stored in VS Code `SecretStorage` only.
- Secrets are not persisted in settings or workspace state.
- Webviews never receive credentials and never call FileMaker endpoints directly.

## Logging and Diagnostics

- Redaction is applied for known sensitive keys/headers/token patterns.
- Request history/metrics are metadata-focused and avoid full record body storage where possible.

## Workspace Trust

- High-risk operations are restricted in untrusted workspaces.
- Offline/read-only paths remain available where safe.

## Vulnerability Reporting

For security issues, report privately to: `alan@abdenterprises.com`.

Please include:
- affected version
- reproduction steps
- impact assessment
- suggested mitigation (if known)

## Disclosure Timeline

- **Acknowledgment:** We aim to acknowledge new vulnerability reports within 48 hours.
- **Initial assessment:** We aim to confirm impact, affected versions, and expected remediation path within 7 calendar days when enough reproduction detail is available.
- **Fix window:** We target a fix or mitigation within 90 days of acknowledgment for confirmed vulnerabilities. Critical issues that could expose credentials, session tokens, or FileMaker data should be prioritized for a shorter emergency patch window.
- **Coordinated disclosure:** Please do not publicly disclose a vulnerability before a fix, mitigation, or mutually agreed disclosure date is available. We will credit reporters when requested and appropriate.

If a report is not actionable because required reproduction details are missing, the timeline pauses until the reporter provides enough information to investigate.
