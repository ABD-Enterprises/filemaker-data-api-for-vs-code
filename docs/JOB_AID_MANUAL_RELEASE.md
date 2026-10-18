# Job aid: publish a release by hand

**When:** the Microsoft Entra publishing setup ([JOB_AID_ENTRA_PUBLISHING.md](./JOB_AID_ENTRA_PUBLISHING.md)) is not done, so the `publish` job in CI cannot run. You build the `.vsix` yourself, upload it to the Marketplace, and create the GitHub release from the same file. **Time:** about 20 minutes. **Who:** a repository admin who is also an owner of the SureForgeTech publisher.

Written for version `1.4.0`; replace the version where it appears. "Checked" below means checked against the named page on 2026-10-18; anything not on an official page is marked **unverified**.

## Before you start

- The release pull request (`[patch] Release 1.4.0`) is **merged** and nothing else will merge before you finish.
- You are signed in to `gh` (`gh auth status`) as an admin of `SureForgeTech/filemaker-data-api-for-vs-code`, and you can sign in at <https://marketplace.visualstudio.com/manage> as an owner of the publisher.
- Node.js 22 or newer and `git`.

## 1. Build the VSIX from the merged commit

```bash
git clone https://github.com/SureForgeTech/filemaker-data-api-for-vs-code.git release-1.4.0   # or use a clean checkout
cd release-1.4.0
git checkout origin/main --detach        # the merged release commit
git log -1 --oneline                     # note this SHA: it is the release commit
grep '"version"' extension/package.json  # must say 1.4.0
npm ci
npm run build
npm run package:check
```

`package:check` first checks that `extension/THIRD_PARTY_NOTICES.txt` is current and then runs `vsce package`. The file is written to `artifacts/filemaker-data-api-tools-1.4.0.vsix` (about 1 MB, 41 files).

Verify it:

```bash
ls -l artifacts/*.vsix
shasum -a 256 artifacts/filemaker-data-api-tools-1.4.0.vsix | tee artifacts/SHA256SUMS.txt   # on Linux: sha256sum
unzip -p artifacts/filemaker-data-api-tools-1.4.0.vsix extension/package.json | grep '"version"'   # "version": "1.4.0"
unzip -l artifacts/filemaker-data-api-tools-1.4.0.vsix | grep -c '\.map$'                         # 0: no source maps in the VSIX
```

Also make the source-map archive (the same command the CI job runs; it is the only way to read a stack trace from the minified bundle, so keep it):

```bash
mkdir -p artifacts/maps
(cd extension/dist && tar -czf ../../artifacts/maps/sourcemaps-v1.4.0.tgz ./*.map)
```

Do not rebuild between steps 1 and 3: the file you upload to the Marketplace and attach to the GitHub release must be the same bytes (compare the sha256).

Sources: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension> (checked: `vsce package` creates the `.vsix`).

## 2. Upload the VSIX to the Marketplace by hand

1. Open <https://marketplace.visualstudio.com/manage> and sign in with the Microsoft account that owns the **SureForgeTech** publisher.
2. Open the **FileMaker Data API Tools** extension. Choose the action to update it with a new package and select `artifacts/filemaker-data-api-tools-1.4.0.vsix`.
3. Wait for verification to finish. The Marketplace validates the package and then shows the new version.

What Microsoft documents: the publishing guide only says to upload the `.vsix` on the "Visual Studio Marketplace publisher management page" and shows a screenshot titled "Add an extension through management page". **The exact menu and button names for updating an existing extension (typically a "..." menu on the extension row with an update action) are unverified**: follow what the page shows. Use a version number that has not been used: the guide says a deleted version's number cannot be reused (checked). That `1.4.0` has to be higher than the published `1.3.0` is the normal rule but is not stated on that page (**unverified**).

If the upload is rejected, read the message on the page. A version that is not higher, a missing icon, or a manifest error are the usual causes; do not change the version to get around it without telling the team.

## 3. Create the GitHub release without a failing publish run

**What a tag does here.** `ci.yml` runs on every pushed `v*` tag: `build-test`, then `package`, then `publish` (which waits for the `marketplace` environment's approval, then fails at "Require the Azure identity settings" because `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` are not set), then `release` (skipped when `publish` fails). So **any `v1.4.0` tag, however created, starts that run**. Only repository admins can create `v*` tags (ruleset `release-tags`); you are one.

`gh release create v1.4.0 --target <sha>` creates the tag itself when it does not exist (checked: <https://cli.github.com/manual/gh_release_create>: "--target: Target branch or full commit SHA"; "gh creates the tag if it doesn't exist"). GitHub's events page does not say whether a tag created through a release fires the `push` trigger; **assume it does** (unverified). A draft release can be edited, and its tag deleted, until it is published (same gh page).

**Safest sequence**

1. Upload to the Marketplace first (step 2) and confirm the version is live, so a problem there does not leave a GitHub release pointing at a version users cannot install.
2. Create the release as a **draft** and check it:

   ```bash
   RELEASE_SHA=$(git rev-parse HEAD)     # the merged release commit from step 1
   bash tools/release-notes.sh v1.4.0 > artifacts/release-notes.md
   head -5 artifacts/release-notes.md    # must show the 1.4.0 notes, not be empty
   gh release create v1.4.0 \
     --repo SureForgeTech/filemaker-data-api-for-vs-code \
     --target "$RELEASE_SHA" \
     --title v1.4.0 \
     --notes-file artifacts/release-notes.md \
     --draft \
     artifacts/filemaker-data-api-tools-1.4.0.vsix \
     artifacts/maps/sourcemaps-v1.4.0.tgz \
     artifacts/SHA256SUMS.txt
   ```

   Open the draft on GitHub (Releases), read the notes, and check that the three files are attached.
3. Publish the draft (the **Publish release** button, or `gh release edit v1.4.0 --draft=false --latest`). Publishing creates the tag `v1.4.0` at `$RELEASE_SHA`.
4. Open **Actions**. A `CI` run for `v1.4.0` will start (assumed above). It runs `build-test` and `package` and then waits at `publish`. **Open the run, choose Review deployments, tick `marketplace`, and Reject.** (Alternatively cancel the run.) The run ends red or cancelled; that is expected. Do **not** approve it: the publish job would only fail at the Azure check, and `release` would try to create a release that already exists.
5. The tag run still builds the VSIX in CI (artifact `extension-vsix`). You can compare its contents with the one you uploaded, but its bytes will differ (different build time stamps), so compare `package.json` version and the file list rather than the hash.

If you would rather not have a red run: there is no supported way to skip it with the current workflow (it only has a tag trigger); the Entra setup removes the problem.

**Do not push the tag yourself** (`git tag` / `git push origin v1.4.0`) before the draft exists: it starts the same run and gives you nothing extra.

## 4. After publishing

- <https://marketplace.visualstudio.com/items?itemName=SureForgeTech.filemaker-data-api-tools> shows **1.4.0** (it can take several minutes) and its **Changelog** tab shows the 1.4.0 section. Or run `npx @vscode/vsce show SureForgeTech.filemaker-data-api-tools` (checked: `vsce show <extensionid>` exists in vsce 4.0.0).
- In a clean VS Code profile, install it from the Marketplace and run **FileMaker: About / Show Version**: it must say 1.4.0 and a build. (`code --user-data-dir /tmp/fm-user --extensions-dir /tmp/fm-ext --install-extension SureForgeTech.filemaker-data-api-tools`.)
- Run the [smoke test](../extension/docs/QA/SMOKE_TEST.md) checks 1 to 12 against a real FileMaker Server.
- Watch issues and the Marketplace Q&A for a week (see [RELEASE.md](./RELEASE.md), step 6).
- Record in the release pull request that the release was published by hand, with the sha256 and the release commit SHA.

## If something is wrong

See [ROLLBACK.md](./ROLLBACK.md): ship a patch release first; unpublishing hides the whole extension and is the last resort. A version that has been published cannot be reused, so a fix is `1.4.1`.
