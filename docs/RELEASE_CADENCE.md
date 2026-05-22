# Release Cadence

This policy defines how FileMaker Data API Tools batches changes into patch, minor, major, pre-release, and security releases.

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

## 4. Pre-Release Channel Usage

Use a pre-release channel for changes that need early adopter validation before stable release:

- risky webview or activation changes,
- new Data API workflows with broad surface area,
- performance changes that need real-world feedback,
- fixes for users who opt in before the next stable release.

Do not use pre-release builds for security fixes that stable users need immediately. Ship those as stable patch releases.

Pre-release builds should use explicit pre-release versions such as `1.2.0-pre.1` and should not be promoted to stable without normal validation.

## 5. Breaking Change Communication

Breaking changes must be communicated before and during release:

- Add migration steps to `extension/UPGRADE.md`.
- Call out the breaking change in `extension/CHANGELOG.md`.
- Include upgrade notes in the PR and release notes.
- Keep deprecated settings or commands working for at least one minor release when practical.
- Provide a rollback or downgrade note when a breaking change can interrupt production workflows.

If a release runbook exists in `docs/RELEASE.md`, keep this cadence policy and that runbook consistent.
