# Repo secrets and rotation policy

This doc names every secret the repo expects, who owns it, when it
expires, and how to rotate it.

## Inventory

| Secret name | Purpose | Required for | Source | Default expiry |
|---|---|---|---|---|
| `VSCE_PAT` | Publish to VS Code Marketplace | Tag-triggered `publish` job in `.github/workflows/ci.yml` | Azure DevOps Personal Access Token (Marketplace → Manage scope, "All accessible organizations") | 1 year |
| `OVSX_PAT` (planned, #160) | Publish to Open VSX Registry | Open VSX `ovsx publish` step in CI | Open VSX user → Settings → New Token | 1 year |
| `ANTHROPIC_API_KEY` (optional) | Claude Code cloud agent (PAYG path) | `.github/workflows/claude-code-agent.yml` Run Claude Code step, only when `CLAUDE_CODE_OAUTH_TOKEN` is unset | https://console.anthropic.com/settings/keys | No expiry (revoke manually) |
| `CLAUDE_CODE_OAUTH_TOKEN` (preferred) | Claude Code cloud agent (subscription path) | Same workflow step as above | `claude setup-token` locally | 1 year |
| `PRS_PAT` (recommended) | Lets agent-opened PRs trigger CI normally | `claude-code-agent.yml` Checkout step + the Claude action's `github_token` input | https://github.com/settings/personal-access-tokens — fine-grained PAT, repo-scoped | 1 year |

## Owners

| Secret | Owner | Owner's Microsoft / Anthropic / GitHub account |
|---|---|---|
| `VSCE_PAT` | Primary maintainer | alan@abdenterprises.com (Microsoft) → `abdenterprises.visualstudio.com` Azure DevOps org |
| `OVSX_PAT` | Primary maintainer | (set when #160 lands) |
| `ANTHROPIC_API_KEY` | Primary maintainer | Anthropic account tied to the maintainer's email |
| `CLAUDE_CODE_OAUTH_TOKEN` | Primary maintainer | Claude Max subscription on the same account |
| `PRS_PAT` | Primary maintainer | GitHub account `deffenda` |

When a secondary maintainer joins (issue #187), each secret gains a
documented backup owner with their own credential — not a shared
credential. That way a single account compromise doesn't lose publish
rights, and rotation can happen without coordination.

## Rotation cadence

**Hard rule**: rotate every secret on its expiration boundary OR every
9 months for no-expiry secrets, whichever is sooner. Set a calendar
reminder + a GitHub Issue with a due date.

### Tracked rotation calendar

| Secret | Last rotated | Expires | Next rotation due |
|---|---|---|---|
| `VSCE_PAT` | _(maintainer fills in on each rotation)_ | _(date)_ | _(date)_ |
| `OVSX_PAT` | (not yet created) | — | — |
| `ANTHROPIC_API_KEY` | (only set if used) | none | 9 months after creation |
| `CLAUDE_CODE_OAUTH_TOKEN` | _(date)_ | _(date)_ | _(date)_ |
| `PRS_PAT` | _(date)_ | _(date)_ | _(date)_ |

This table is the source of truth. Edit it in a PR every rotation.
The reminder workflow (next section) reads this table.

## Reminder mechanism

A scheduled GitHub Actions workflow runs monthly, parses the dates from
this doc, and opens an issue 30 days before any secret's "Next rotation
due" date. That issue is labeled `ops/secret-rotation` so triage
catches it.

**Implementation status**: scaffolded in
`.github/workflows/secret-rotation-reminder.yml`. The workflow is
currently a no-op stub — it doesn't yet parse dates from this doc.
Filling in the parser is its own follow-up; meanwhile, the calendar
reminder is the trustworthy mechanism.

If the workflow fails or the reminder doesn't fire, the underlying
calendar reminder kicks in 30 days before expiration regardless.

## How to rotate `VSCE_PAT`

The most-rotated secret. Steps:

1. Go to https://dev.azure.com/abdenterprises/_usersSettings/tokens
   (sign in as the primary owner).
2. Find the existing `vsce-publish-filemaker` token (or whichever
   name).
3. Click **Regenerate** OR create a new token with:
   - **Name**: `vsce-publish-filemaker-YYYY-MM` (year-month so old
     names don't collide)
   - **Organization**: **All accessible organizations** (required)
   - **Expiration**: 1 year
   - **Scopes**: Click **Show all scopes** → **Marketplace** → **Manage**
4. Copy the token (shown once).
5. Update the GitHub secret:
   ```bash
   gh secret set VSCE_PAT --repo ABD-Enterprises/filemaker-data-api-for-vs-code
   # paste at the prompt
   ```
6. Test by running the publish job on a pre-release tag:
   ```bash
   git tag -a v1.1.1-pre.1 -m "test PAT" && git push origin v1.1.1-pre.1
   # watch the run; on success, delete the tag/release
   ```
7. Update the **Tracked rotation calendar** table above in a PR.

## How to rotate `CLAUDE_CODE_OAUTH_TOKEN`

1. Locally: `claude setup-token` (prints a new token).
2. Copy the token (shown once).
3. `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ABD-Enterprises/filemaker-data-api-for-vs-code` — paste.
4. Test by dispatching the cloud agent workflow on a safe ticket
   (any in `ai/ready-for-work`): `gh workflow run claude-code-agent.yml -f issue_number=<N>`.
5. Update the calendar table above in a PR.

## How to rotate `PRS_PAT`

1. Go to https://github.com/settings/personal-access-tokens.
2. Find the existing fine-grained PAT (or create a new one):
   - Name: `prs-filemaker-vscode-YYYY-MM`
   - Resource owner: `ABD-Enterprises`
   - Repository access: `filemaker-data-api-for-vs-code` only
   - Permissions: Contents r/w, Issues r/w, Pull requests r/w
   - Expiration: 1 year
3. Generate, copy.
4. `gh secret set PRS_PAT --repo ABD-Enterprises/filemaker-data-api-for-vs-code` — paste.
5. Test by dispatching the cloud agent workflow.
6. Update the calendar table.

## What NOT to rotate via this process

- **GitHub `GITHUB_TOKEN`**: managed by GitHub Actions, no manual
  rotation. Don't touch.
- **OAuth app secrets** (if/when added): rotation lives in the OAuth
  app's settings on GitHub, not in this table.

## Audit trail

Every rotation creates a PR that updates the calendar table. Search
PRs by label `ops/secret-rotation` to see the full history.

## If a secret is compromised

1. **Revoke immediately** at the source (Azure DevOps PAT page,
   Anthropic console, GitHub PAT settings).
2. **Rotate** as documented above.
3. **Audit**: check the Actions log for the time window between
   compromise and revocation. Look for unauthorized workflow runs.
4. **Disclose** if user data could have been affected (see
   `extension/SECURITY.md`).

Cross-reference: [MAINTAINERS.md](./MAINTAINERS.md) for ownership and
emergency handoff rules.
