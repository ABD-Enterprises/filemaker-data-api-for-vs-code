# Maintainers

This project's bus factor is the riskiest part of its long-term health.
This doc names who's responsible for what, the succession plan, and how
a handoff actually works in practice.

## Current maintainers

| Role | Name | GitHub | Responsibility |
|---|---|---|---|
| **Primary** | Alan Deffenderfer | [@deffenda](https://github.com/deffenda) | Release cuts, Marketplace publish, security response, roadmap |
| **Secondary** | _(open)_ | _(open)_ | Backup release path, triage when primary unavailable, PR review |

**Wanted: a secondary maintainer.** If you're a FileMaker developer using
this extension regularly and would like to help keep it healthy, see the
"Becoming a secondary maintainer" section below.

## Responsibilities

### Primary maintainer

- Cuts releases per the cadence policy
  ([release runbook](./RELEASE.md), filed in issue #140)
- Holds the VS Code Marketplace publisher credentials (the `deffenda`
  publisher on https://marketplace.visualstudio.com)
- Holds the Azure DevOps account that owns the publisher
- Holds the Open VSX publisher (once issue #160 lands)
- First responder to security reports (see [SECURITY.md](../extension/SECURITY.md))
- Approves PRs from the cloud agent (Codex / Claude Code) per the
  separation-of-duties rule in `CLAUDE.md`
- Owns the [`VSCE_PAT`](./SECRETS.md once issue #142 lands) rotation cycle

### Secondary maintainer

- Can publish a release if the primary is unavailable >7 days
- Can sign off on PRs from cloud agents in the primary's absence
- Reviews + triages incoming bug reports / feature requests during the
  primary's vacation / outages
- Holds a backup PAT for `VSCE_PAT` (separate token, separate Microsoft
  account) so a single account compromise doesn't lose publish rights

## Succession path

If the primary maintainer needs to step back permanently:

1. **Announce in GitHub Discussions** (Announcements category, once #134
   enables Discussions) with a 30-day notice window.
2. **Transfer the Marketplace publisher** ownership to the secondary OR
   create a new publisher under the secondary's account and re-publish
   the next release under the new publisher (users on the old version
   keep it, new installs come from the new publisher — document the
   migration in CHANGELOG).
3. **Update CODEOWNERS, FUNDING.yml, repo About, and this doc** with
   the new primary.
4. **Hand off the `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `VSCE_PAT`
   / `PRS_PAT`** repo secrets — primary regenerates them under their
   accounts; old ones revoked.
5. **Old primary remains in CONTRIBUTORS** but no longer holds publish
   credentials.

If the primary becomes **suddenly unavailable** (hospitalization,
medical emergency, etc.):

- The secondary maintains read-only awareness via the audit trail of
  cloud-agent PRs + the project's GitHub Discussions.
- The secondary has standing authority to merge PRs that have green CI
  and Gemini approval, including releases up to a patch version.
- Minor and major releases wait for the primary's return OR a documented
  30-day no-contact period before the secondary cuts them.
- The "emergency handoff" rules above kick in only after 30 days of
  no-contact AND a community vote in GitHub Discussions confirming the
  succession.

## Becoming a secondary maintainer

Steps a candidate takes:

1. Open a GitHub Discussion (Ideas category, once #134 lands) introducing
   yourself — name, where you use this extension, why you want to help.
2. Demonstrate engagement: submit 2-3 meaningful PRs (not just typo fixes)
   over a 30-day period.
3. The primary reviews engagement quality + alignment with the project's
   goals + sustainable bandwidth.
4. On agreement, the primary opens a PR adding the candidate to the
   "Current maintainers" table here and grants them:
   - Repo write access (for label management + PR merges)
   - A documented place in the FUNDING.yml split (if/when sponsorship
     income exceeds a documented threshold)
   - Backup secret store access (timing TBD; depends on candidate's
     OPSEC readiness)

This is intentionally a slow process. Maintainer rights propagate forever;
revoking them is socially expensive. Better to take 60 days getting it
right than to grant in a week and regret it.

## Out of scope for this doc

- Day-to-day contribution rules: see [CONTRIBUTING.md](../extension/CONTRIBUTING.md)
- Security reporting: see [SECURITY.md](../extension/SECURITY.md)
- Funding model: see [FUNDING.md](./FUNDING.md)
- Code of Conduct enforcement contact: see CODE_OF_CONDUCT.md
  (filed in issue #133)
