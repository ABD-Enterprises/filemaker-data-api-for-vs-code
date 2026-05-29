# Dependency Policy

This repository uses Dependabot for npm dependency updates and GitHub Actions
for the minimum safe auto-merge path.

## Cadence

| Update class | Cadence | Handling |
| --- | --- | --- |
| Development dependencies | Weekly on Monday at 09:00 UTC | Grouped into one `dev-dependencies` PR where Dependabot can group them. Patch and minor direct dev-dependency PRs may auto-merge after required checks pass. |
| Production dependencies | Monthly effective cadence | Grouped into one `production-dependencies` PR where Dependabot can group them. The npm ecosystem check runs weekly because GitHub requires one npm entry per directory/target branch, and production package names use a 30-day cooldown. Human review is required. |
| Security updates | Reviewed daily | Grouped as `security-patches` when Dependabot can group security updates. Human review is required unless a maintainer explicitly approves another path. |

## Auto-merge Rules

`.github/workflows/dependency-auto-merge.yml` only enables auto-merge for
Dependabot pull requests when all of the following are true:

- The actor is `dependabot[bot]`.
- The PR targets `main` and is not a draft.
- `dependabot/fetch-metadata` reports `dependency-type` as `direct:development`.
- The update type is `version-update:semver-patch` or
  `version-update:semver-minor`.
- Required checks pass before GitHub completes the auto-merge.

The workflow enables GitHub auto-merge; it does not bypass branch protection or
merge a PR while required checks are pending or failing.

## Human Review Required

Human review is required for:

- Production dependency updates.
- Any semver-major update.
- Security updates, including grouped security patches.
- Any dependency PR with failing, skipped, or unclear validation.
- Any dependency PR that changes lockfile structure, build tooling behavior, or
  extension packaging output in a non-obvious way.

## Audit Routine

- Review Dependabot security alerts each business day.
- Review grouped development dependency PRs weekly.
- Review grouped production dependency PRs monthly.
- Keep `npm audit --omit=dev --audit-level=high` in CI as the minimum automated
  production-dependency audit gate.
- When a dependency is intentionally pinned or ignored, keep the reason in
  `.github/dependabot.yml` next to the rule.
