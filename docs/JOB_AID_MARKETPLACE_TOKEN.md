# Job aid: give the release pipeline a Marketplace token (superseded)

> **Superseded.** The release pipeline now signs in with Microsoft Entra ID and no longer reads `VSCE_PAT`. Use [JOB_AID_ENTRA_PUBLISHING.md](./JOB_AID_ENTRA_PUBLISHING.md). This page is kept for the manual-upload note and the retirement background.

**When:** before the next `v*` release tag. Without it the `publish` job fails at the last step.
**Time:** about 10 minutes. **Who:** the publisher owner (needs admin on the repo).
**Checked against current Microsoft and GitHub docs on 2026-10-18** (links in each step).

## Read this first: the token has an end date

Microsoft is retiring the kind of Azure DevOps token that `vsce` needs ("global" personal access tokens, the ones created with **All accessible organizations**) on **1 December 2026**. A token you create today works until then. Microsoft recommends Microsoft Entra ID (workload identity federation or a managed identity) with `vsce publish --azure-credential` instead.
Sources: [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [Azure DevOps announcement](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/).

So you have two ways to publish. Pick one:

| | Token (this job aid) | Manual upload |
|---|---|---|
| Effort | 10 minutes, then automatic | 3 minutes per release |
| Works after 1 Dec 2026 | No, switch to Entra before then | Yes |
| Secrets to manage | One | None |

If you only release a few times before December, manual upload is simplest: download the `.vsix` from the GitHub release, then upload it on the publisher management page, <https://marketplace.visualstudio.com/manage>. Microsoft's guide only says to upload the `.vsix` there (with a screenshot titled "Add an extension through management page"); the exact menu wording was not confirmed, so follow the screenshot in the [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## Part A: create the token

1. Sign in to Azure DevOps at <https://dev.azure.com> with the Microsoft account that owns the `SureForgeTech` publisher. (No organization yet? Create one: <https://learn.microsoft.com/azure/devops/organizations/accounts/create-organization>.)
2. Click the **User settings** icon next to your profile picture, then **Personal access tokens**.
3. Click **New Token**.
4. Fill in:
   - **Name:** `vsce-publish-filemaker-data-api`
   - **Organization:** **All accessible organizations** (the VS Code guide says to choose this; a single organization commonly gives 401/403 errors)
   - **Expiration:** pick the latest date offered, or 30 November 2026
   - **Scopes:** **Custom defined**, click **Show all scopes**, scroll to **Marketplace**, tick **Manage**
5. Click **Create** and **copy the token now**. It is shown only once.

## Part B: check it works (optional, 1 minute)

In a terminal:

```bash
npx @vscode/vsce@4.0.0 login SureForgeTech
```

Paste the token when asked. You should see that it was verified. (This stores the token on your computer; skip this part if you would rather not.) If you get 401 or 403, redo Part A step 4 (the organization setting is the usual cause).

## Part C: store it where only the release job can read it

The `marketplace` environment already exists and requires your approval before it runs.

**In the browser:**

1. Open <https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/settings/environments>.
2. Click **marketplace**.
3. Under **Environment secrets**, click **Add secret**.
4. **Name:** `VSCE_PAT` (exactly). **Value:** paste the token.
5. Click **Add secret**.

Source: [GitHub docs, secrets for an environment](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/using-secrets-in-github-actions).

**Or in a terminal** (it prompts for the value, so the token never appears in your shell history):

```bash
gh secret set VSCE_PAT --env marketplace --repo SureForgeTech/filemaker-data-api-for-vs-code
```

Source: [gh secret set](https://cli.github.com/manual/gh_secret_set).

## Part D: confirm

Open <https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/settings/environments>, click **marketplace**, and check that `VSCE_PAT` is listed under **Environment secrets**. There should be no `VSCE_PAT` under repository secrets (it was deleted so other jobs cannot read it).

## When you release

Push the `v*` tag. The `publish` job pauses and GitHub asks you to approve it (the **Review deployments** button on the run). Approve, and the extension is published.

## Before 1 December 2026

Replace the token with Microsoft Entra ID so publishing keeps working. The steps are in the [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) (the Entra ID section). Microsoft's example is for Azure Pipelines; the GitHub Actions version has not been worked out here and needs a design before the cut-over. Until then, manual upload always works.

## Not confirmed from Microsoft's docs

- The maximum lifetime a token can have (an administrator can limit it).
- The lowest publisher role a token holder needs. Use the publisher's owner account.
