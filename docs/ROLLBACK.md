# Marketplace Rollback Playbook

Use this playbook when a published VS Code Marketplace release of `deffenda.filemaker-data-api-tools` is broken, unsafe, or misleading.

## Decision Tree

1. **Can a patch release fix users quickly without hiding the extension?**
   - Yes: ship a patch release that supersedes the bad version.
   - No: continue.
2. **Is the published version unsafe, destructive, or unusable for most users?**
   - Yes: unpublish the extension while preparing a fixed release.
   - No: publish a patch release and document the known issue.
3. **Is this only an early-access build?**
   - Yes: use the pre-release channel for the replacement build when that channel is configured.
   - No: use the stable patch-release path.

Current `vsce` help documents unpublishing the extension as a whole, not safely removing a single Marketplace version. Do not assume version-specific unpublish is available. Prefer a patch release unless the extension must be hidden immediately.

## Mark A Release As Bad

1. Open or pin a GitHub issue titled `Known issue: vX.Y.Z`.
2. Add the impact, affected versions, workaround, and owner.
3. Update `extension/CHANGELOG.md` in the fix PR with a short deprecation or known-bad note for the affected version.
4. If the release is severe enough to hide, unpublish the extension:
   ```bash
   cd extension
   npx @vscode/vsce unpublish deffenda.filemaker-data-api-tools
   ```
5. For non-interactive emergency use by a trusted local maintainer only:
   ```bash
   cd extension
   VSCE_PAT=... npx @vscode/vsce unpublish deffenda.filemaker-data-api-tools --force
   ```

Unpublishing removes the extension from normal Marketplace download flow. It is heavier than publishing a fixed patch and should be reserved for severe defects.

## Ship A Patch Release

1. Branch from latest `main`.
2. Fix only the rollback-critical issue.
3. Bump `extension/package.json` to the next patch version.
4. Update `extension/CHANGELOG.md` with:
   - the bad version
   - the user impact
   - the fix
   - any manual recovery steps
5. Validate locally:
   ```bash
   npm install
   npm run lint
   npm run typecheck
   npm test
   npm run package:check
   ```
6. Open a PR and wait for required review and CI.
7. After merge, tag the patch release from `main`:
   ```bash
   git fetch origin --prune
   git checkout main
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
8. Watch the tag workflow publish the VSIX.
9. Verify the Marketplace listing shows the fixed version.

## Communicate With Users

Use all channels that are enabled for the repo:

- GitHub issue: pin or clearly label the known-bad release issue.
- GitHub Discussions: post an announcement when Discussions are enabled.
- Release notes: call out the bad version and fixed version in the patch release notes.
- Marketplace listing: ensure the changelog visible on Marketplace points users to the fixed version.

Use concise status language:

```text
Version X.Y.Z has a known issue affecting <workflow>. Upgrade to X.Y.Z+1.
If you already configured <feature>, follow these recovery steps: <steps>.
```

## Pre-Release Vs Full Unpublish

- Use `--pre-release` for a replacement build only when the fix is intended for early adopters and the pre-release channel is configured.
- Use a stable patch when stable users are affected.
- Use full unpublish only when keeping the extension available would expose users to data loss, credential leakage, install failure, or a major broken first-run path.

Example pre-release publish command for a trusted maintainer:

```bash
cd extension
npx @vscode/vsce publish --pre-release
```

The current CI stable publish path uses tags and `VSCE_PAT`. Do not publish production releases from an untrusted environment.

## Verification After Recovery

- Marketplace shows the fixed version or the extension is hidden if unpublished.
- A clean VS Code profile installs the expected fixed version.
- The broken workflow is verified against the release smoke test.
- The known-issue GitHub thread links to the fixed release.
- Any rollback-specific notes are present in `extension/CHANGELOG.md`.

## References

- [VS Code publishing extensions documentation](https://github.com/microsoft/vscode-docs/blob/main/api/working-with-extensions/publishing-extension.md)
- `npx @vscode/vsce unpublish --help`
- `npx @vscode/vsce publish --help`
