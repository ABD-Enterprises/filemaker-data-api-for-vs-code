# Maintainers

Who is responsible for what, and how a handoff works. This project's bus factor is the riskiest part of its long-term health.

## Current maintainers

| Role | Name | GitHub | Responsibility |
| --- | --- | --- | --- |
| Primary | Alan Deffenderfer | [@deffenda](https://github.com/deffenda) | Releases, Marketplace publishing, security response, roadmap |
| Secondary | _(open)_ | _(open)_ | Backup release path, triage when the primary is unavailable, review |

A secondary maintainer is wanted. If you use the extension regularly and want to help, see "Becoming a secondary maintainer" below.

## Responsibilities

### Primary maintainer

- Cuts releases following [RELEASE.md](./RELEASE.md) and the [cadence](./RELEASE_CADENCE.md), including the non-code checklist (docs, upgrade notes, listing, announcement, monitoring).
- Owns the **SureForgeTech** publisher on the VS Code Marketplace and its Microsoft Entra publishing identity ([JOB_AID_ENTRA_PUBLISHING.md](./JOB_AID_ENTRA_PUBLISHING.md), [SECRETS.md](./SECRETS.md)).
- Approves the `marketplace` environment deployment for each release.
- First responder to security reports ([SECURITY.md](../SECURITY.md)).
- Triages issues (templates ask for versions and logs) and keeps [CHANGELOG](../extension/CHANGELOG.md) and [UPGRADE](../extension/UPGRADE.md) honest.

### Secondary maintainer

- Can publish a release if the primary is unavailable for more than 7 days.
- Reviews and triages while the primary is away.
- Is a second owner of the Marketplace publisher and of the `marketplace` environment's required reviewers, so one lost account does not lose the ability to publish.

## Succession

If the primary maintainer needs to step back for good:

1. Announce it in the repository (an issue and the README) with a 30-day notice.
2. Transfer or share ownership of the Marketplace publisher with the secondary, and add them as a reviewer of the `marketplace` environment. If a new publisher must be created, publish the next release under it and say so in the changelog; users on the old version keep it, new installs come from the new publisher.
3. Update `CODEOWNERS`, `.github/FUNDING.yml`, `.well-known/security.txt`, [SECURITY.md](../SECURITY.md), the Marketplace `homepage` and this page.
4. Repeat the Entra setup under the new owner's account and replace `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`.
5. The old primary no longer holds publish credentials.

If the primary becomes suddenly unavailable, the secondary keeps issues and pull requests moving, may merge pull requests that pass `build-test`, and may cut patch releases. Minor and major releases wait for the primary, or for 30 days without contact.

## Becoming a secondary maintainer

1. Open an issue introducing yourself: where you use the extension and why you want to help.
2. Show engagement: two or three meaningful pull requests over about 30 days (not only typo fixes).
3. The primary reviews engagement quality, alignment with the project and available time.
4. On agreement the primary opens a pull request adding you to the table above and grants repository write access.

Maintainer rights are hard to take back, so this is intentionally slow.

## Other pages

- Contributing: [CONTRIBUTING.md](../extension/CONTRIBUTING.md)
- Security reporting: [SECURITY.md](../SECURITY.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)
