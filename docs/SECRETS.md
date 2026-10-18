# Secrets and credentials

This repository holds **no repository secrets**. Check with `gh secret list --repo SureForgeTech/filemaker-data-api-for-vs-code`; the list should be empty.

## Inventory

| Name | Where | What it is | Secret? |
| --- | --- | --- | --- |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` | Variables on the `marketplace` environment | Identifiers of the Microsoft Entra managed identity that publishes to the Marketplace. Setup: [JOB_AID_ENTRA_PUBLISHING.md](./JOB_AID_ENTRA_PUBLISHING.md). Not set yet, so publishing is manual until the setup is done ([RELEASE.md](./RELEASE.md#manual-publish-fallback)). | No |
| `LINUX_RUNNER_LABELS` | Repository variable | Runner labels for CI jobs | No |
| `GITHUB_TOKEN` | Provided by GitHub Actions per run | Used by the release job and workflows with explicit permissions | Managed by GitHub |

Publishing signs in with a short-lived GitHub OIDC token exchanged for the managed identity, restricted to the `marketplace` environment (tags only, a required reviewer). There is no personal access token to store or renew. The old `VSCE_PAT` token type stops working on 2026-12-01 in any case; if a `VSCE_PAT` secret turns up, delete it.

Not in use any more: the Claude Code cloud agent secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `PRS_PAT`) were removed together with the workflow that used them. Open VSX publishing (`OVSX_PAT`) was planned and never set up.

## If you add a secret

1. Prefer something that is not a secret (OIDC, a variable).
2. Scope it to an environment with a required reviewer, not the whole repository, and give the job that uses it the narrowest permissions.
3. Never run `npm ci` or other dependency install scripts in a job that holds it (the `publish` job installs `vsce` from its own lockfile with `--ignore-scripts` for this reason).
4. Add a row to the table above with an owner and an expiry, and set a calendar reminder 30 days before the expiry. The monthly `secret-rotation-reminder.yml` workflow is a scaffold that does nothing yet; do not rely on it.
5. Document how to rotate it here.

## If a credential is exposed

1. Revoke it at the source straight away (Azure portal, Marketplace publisher page, GitHub settings).
2. Rotate it as documented above.
3. Check the Actions run history for the period between exposure and revocation for runs you do not recognize.
4. If user data could be affected, follow the [security policy](../SECURITY.md) and tell users in the release notes.

## What this extension stores for users

User passwords, proxy API keys and session tokens are in VS Code SecretStorage on the user's machine. See [DATA_HANDLING.md](./DATA_HANDLING.md).

Ownership and succession: [MAINTAINERS.md](./MAINTAINERS.md).
