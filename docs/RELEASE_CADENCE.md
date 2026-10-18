# Release Cadence

This policy defines how FileMaker Data API Tools batches changes into patch, minor, major and security releases. The step-by-step process, including the non-code checklist, is in [RELEASE.md](./RELEASE.md).

## 1. SemVer Interpretation

Marketplace releases use the version in `extension/package.json`.

- **Patch** releases fix defects or improve reliability without changing the expected user workflow. Examples: crash fixes, packaging fixes, dependency patches, documentation corrections, small accessibility fixes, and compatibility fixes for an existing command.
- **Minor** releases add compatible functionality. Examples: new commands, new settings, new FileMaker Data API workflows, new explorer nodes, new webview capabilities, new diagnostics, or new supported packaging/release automation.
- **Major** releases introduce planned breaking changes. Examples: removing command IDs, changing persisted profile/query formats without automatic migration, dropping supported VS Code or FileMaker Server versions, changing authentication expectations, or removing settings.

The root monorepo package version is not the Marketplace release version unless a separate tooling release explicitly says so.

## 2. Cadence

- **Patch:** Cut as needed for confirmed bugs, packaging failures, security fixes, or release-blocking documentation corrections.
- **Minor:** Aim for a monthly rollup when there are enough user-facing improvements to justify an upgrade. Skip the monthly release if the change set is too small.
- **Major:** Cut rarely, only after migration notes and deprecation notice are available.
- **No-change periods:** Do not publish only to satisfy a calendar date. A release needs a user-facing fix, feature, compatibility update, or operational reason.

## 3. LTS And Backports

The project does not currently maintain long-term support branches.

Security fixes should be shipped on the latest stable line as a patch release. Backports to older release lines are best-effort and should be considered only when:

- the affected older version is widely deployed,
- the fix is low-risk and easy to isolate,
- the current stable line cannot be adopted quickly by affected users,
- a maintainer is available to validate the backport.

If a backport is approved, document the supported version range in release notes.

## 4. Pre-Release Channel

There is no pre-release channel today. The CI publish job publishes stable versions only, and the Marketplace does not accept semver suffixes such as `1.5.0-pre.1`: a pre-release is an ordinary version number published with `vsce publish --pre-release`, and Microsoft recommends odd minor numbers for pre-releases and even ones for stable. This project uses consecutive minor numbers (1.2, 1.3, 1.4), so a pre-release would need a written decision on the version scheme and a manual publish.

If one is ever used, it is for changes that need early adopter validation (risky webview or activation changes, broad new Data API workflows, performance work). Security fixes that stable users need always ship as stable patch releases.

## 5. Breaking Change Communication

Breaking changes must be communicated before and during release:

- Add migration steps to `extension/UPGRADE.md`, and update the [User Guide](../extension/docs/USER_GUIDE.md).
- Call out the breaking change in `extension/CHANGELOG.md`.
- Include upgrade notes in the PR and release notes.
- Keep deprecated settings or commands working for at least one minor release when practical.
- Provide a rollback or downgrade note when a breaking change can interrupt production workflows.

## 6. Announcement and follow-up

A release is announced when it changes what users see. A patch that only fixes a defect needs the GitHub release notes. A minor or major release also gets upgrade notes, an updated user guide and a short community post. Watch issues and Marketplace reviews for a week after every release; see the checklist in [RELEASE.md](./RELEASE.md).
