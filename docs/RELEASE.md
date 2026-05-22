# Release Runbook

Use this runbook for VS Code Marketplace releases of FileMaker Data API Tools. Releases are cut from `main` after review, local validation, and CI are green.

## Versioning Policy

The extension follows semantic versioning in `extension/package.json`.

- **Patch** (`1.1.1`): bug fixes, documentation corrections, dependency updates with no intended user-facing behavior change, packaging fixes, or reliability fixes for existing workflows.
- **Minor** (`1.2.0`): new commands, new settings, new supported FileMaker Data API workflows, new webview capabilities, or compatible behavior changes that existing users can adopt without migration.
- **Major** (`2.0.0`): breaking command IDs, removed settings, incompatible saved profile/query formats, changed authentication expectations, dropped VS Code/FileMaker Server support, or any migration that users must plan.

Keep the root package version independent unless the monorepo tooling itself is being released. Marketplace versioning is controlled by `extension/package.json`.

## Cut A Release

1. Start from latest `main`.
2. Create a release branch such as `release/v1.1.1`.
3. Update `extension/package.json` to the target version.
4. Update `extension/CHANGELOG.md` with the release date, summary, user-facing changes, fixes, and validation notes.
5. Run local validation:
   ```bash
   npm install
   npm run lint
   npm run typecheck
   npm test
   npm run package:check
   ```
6. Open a release PR against `main`.
7. Wait for required review and CI (`build-test`, CodeQL, risk labeling, and PR review automation).
8. Merge the release PR after approval.
9. Tag the merge commit on `main`:
   ```bash
   git fetch origin --prune
   git checkout main
   git pull --ff-only
   git tag v1.1.1
   git push origin v1.1.1
   ```
10. Watch GitHub Actions for the tag workflow. The tag path packages the VSIX and publishes with `VSCE_PAT`.
11. Verify the Marketplace listing after publish.

Do not skip local validation because the tag publish path spends CI minutes and can publish directly to Marketplace.

## Pre-Release Vs Stable Channels

- **Stable** releases use a normal semver version and a `v*` tag. The current CI publish job is built for this path.
- **Pre-release** builds should use an explicit pre-release version such as `1.2.0-beta.1` and be published only when the Marketplace pre-release workflow is intentionally configured. Do not tag or publish a pre-release through the stable path by accident.
- Keep preview/sandbox validation separate from production Marketplace publishing unless CI explicitly documents a trusted pre-release channel.

## Marketplace Verification

After the publish job finishes, verify:

- The Marketplace page shows the new version.
- The changelog content is visible and matches `extension/CHANGELOG.md`.
- Screenshots and marketplace images load.
- Install from Marketplace works in a clean VS Code profile.
- The installed extension version matches `extension/package.json`.
- First-run walkthrough, Add Connection Profile, Test Connection, Query Builder, and status bar smoke-test paths still work.

If the listing does not update immediately, wait for Marketplace propagation before retrying the publish job.

## If Publish Fails

1. Read the failing GitHub Actions log before rerunning anything.
2. If packaging failed, reproduce locally with `npm run package:check`.
3. If authentication failed, verify `VSCE_PAT` exists, is not expired, and has Marketplace publish access.
4. If the Marketplace rejects the version, confirm the version was not already published and that `extension/package.json` matches the tag intent.
5. If the failure is transient Marketplace or GitHub infrastructure, rerun only the failed job after recording the reason.
6. If a broken release was published, use the rollback playbook once it exists; until then, publish a fixed patch release rather than force-changing tags.

## Release PR Checklist Template

Paste this into the release PR body:

```markdown
## Release

- Version: `vX.Y.Z`
- Release type: patch / minor / major
- Marketplace channel: stable / pre-release

## Changes

- [ ] `extension/package.json` version bumped
- [ ] `extension/CHANGELOG.md` updated
- [ ] Migration or compatibility notes included, if needed

## Local Validation

- [ ] `npm install`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run package:check`

## Post-Merge

- [ ] Tag `vX.Y.Z` pushed from the merge commit on `main`
- [ ] Tag workflow completed successfully
- [ ] Marketplace listing shows `vX.Y.Z`
- [ ] Fresh install smoke test completed
```
