# Marketplace rollback playbook

Use this when a published release of `SureForgeTech.filemaker-data-api-tools` is broken, unsafe or misleading. The normal process is in [RELEASE.md](./RELEASE.md).

## Decision tree

1. **Can a patch release fix users quickly without hiding the extension?** Yes: ship a patch release that supersedes the bad version. No: continue.
2. **Is the published version unsafe, destructive or unusable for most users?** Yes: consider unpublishing the extension while you prepare the fix. No: publish a patch and document the known issue.

The Marketplace has no "yank one version" that `vsce` can do: `vsce unpublish` removes the whole extension. Prefer a patch unless the extension must disappear immediately. There is no pre-release channel to fall back to (see [RELEASE_CADENCE.md](./RELEASE_CADENCE.md)).

## Within the first hour

1. Reproduce it. Record the version, VS Code version, operating system and steps.
2. Open a pinned GitHub issue titled `Known issue: vX.Y.Z` with the impact, affected versions, a workaround and an owner.
3. Tell users how to go back. In VS Code a user can open the extension in the Extensions view, choose the gear menu and **Install Specific Version...**, then pick the previous version. They can also install an earlier `.vsix` from the [GitHub releases](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases) (only versions that were tagged have one). Put the steps in the known-issue text and add: turn off automatic updates for this extension if needed.
4. Check whether data or credentials are at risk. If so, follow the [security policy](../SECURITY.md) and treat it as a security incident.

## Ship a patch release

1. Branch from latest `main`. Fix only the rollback-critical issue.
2. Bump `extension/package.json` to the next patch version (see the checklist in [RELEASE.md](./RELEASE.md)).
3. Update `extension/CHANGELOG.md` with the bad version, the user impact, the fix and any manual recovery steps. Add recovery steps to `extension/UPGRADE.md` if users must do something.
4. Validate locally:
   ```bash
   npm ci
   npm run lint
   npm run typecheck
   npm test
   npm run package:check
   ```
5. Open a PR and wait for `build-test`.
6. After merge, tag from `main` and push the tag as described in [RELEASE.md](./RELEASE.md) (step 4). Approve the `marketplace` environment when the publish job waits. If Entra publishing is not set up, use the [manual publish](./RELEASE.md#manual-publish-fallback) steps.
7. Verify the Marketplace listing shows the fixed version.

## Unpublish (last resort)

Unpublishing removes the extension from normal Marketplace download flow and hides the listing. It is much heavier than a patch. Use it only when keeping the extension available would expose users to data loss, credential leakage, install failure or a broken first run.

Do it from the publisher management page, <https://marketplace.visualstudio.com/manage>, signed in as an owner of the SureForgeTech publisher. Or from a terminal signed in with Microsoft Entra ID (no stored token):

```bash
az login
cd extension
npx @vscode/vsce unpublish SureForgeTech.filemaker-data-api-tools --azure-credential
```

`vsce login SureForgeTech` stores a personal access token on the machine until you run `vsce logout`. Avoid it, and remove it afterwards if you used it. Publish a fixed version as soon as you can, which makes the extension visible again.

## Communicate with users

Use every channel that is enabled:

- The pinned GitHub issue.
- The GitHub release notes of the fixed version: name the bad version and the fixed one.
- The Marketplace Changelog tab (it shows `extension/CHANGELOG.md`).
- A short post wherever you announced the bad release.

Plain wording:

```text
Version X.Y.Z has a known issue affecting <workflow>. Upgrade to X.Y.Z+1.
If you already configured <feature>, follow these recovery steps: <steps>.
```

## Verify the recovery

- The Marketplace shows the fixed version, or the extension is hidden if unpublished.
- A clean VS Code profile installs the expected version.
- The broken workflow works against the [smoke test](../extension/docs/QA/SMOKE_TEST.md).
- The known-issue thread links to the fixed release and is closed.
- `extension/CHANGELOG.md` and `extension/UPGRADE.md` carry the rollback notes.
- Write down what failed in the process and fix [RELEASE.md](./RELEASE.md).

## References

- [VS Code: publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- `npx @vscode/vsce unpublish --help`
