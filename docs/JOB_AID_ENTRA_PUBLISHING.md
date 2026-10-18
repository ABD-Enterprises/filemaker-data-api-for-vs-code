# Job aid: set up token-free publishing with Microsoft Entra ID

**Why:** Azure DevOps personal access tokens (what `vsce` used) stop working on **1 December 2026**. This setup lets GitHub publish to the Marketplace with a short-lived sign-in instead, so there is no token to create, store or renew.
**Time:** about 20 minutes, once. **Cost:** free (managed identities and federated credentials have no charge).
**Checked against current docs on 2026-10-18.** Where a step could not be confirmed from Microsoft's documentation it is marked **(unconfirmed)**; the first real publish is the test.

If anything here fails, you can still release by uploading the `.vsix` by hand at <https://marketplace.visualstudio.com/manage>. Nothing in this setup blocks that.

## What you need

- The Microsoft account that owns the `SureForgeTech` publisher.
- An Azure account with a subscription (the free account is enough): <https://azure.microsoft.com/free>. You need it only to create the identity; the identity itself should need no Azure permissions. Microsoft's Azure Pipelines instructions mention giving it the Reader role, but our login uses `allow-no-subscriptions`, which skips that. If the sign-in step later says it found no subscription, give the identity the Reader role on your subscription and try again.
- Admin on the GitHub repo (you are).

## Part 1: create the identity in Azure (5 minutes)

1. Go to <https://portal.azure.com> and sign in.
2. In the top search box type **Managed Identities** and open it, then click **+ Create**.
3. Choose your subscription, create or pick a resource group (for example `publishing`), pick any region, and name it `vsce-publisher`. Click **Review + create**, then **Create**.
4. When it finishes click **Go to resource**.

## Part 2: let only the `marketplace` environment use it (5 minutes)

This repository's GitHub sign-in claim uses the permanent-ID format (it contains numeric ids), so the portal's built-in "Environment" shortcut would create a credential that does not match, and that fails silently later. Use the **Other issuer** scenario with the exact values below.

In the identity's page:

1. In the left menu open **Settings > Federated credentials**, then **+ Add credential**.
2. **Federated credential scenario:** **Other issuer**.
3. Fill in:
   - **Issuer:** `https://token.actions.githubusercontent.com`
   - **Type:** Explicit subject identifier
   - **Subject identifier:** `repo:SureForgeTech@343994947/filemaker-data-api-for-vs-code@1171265957:environment:marketplace`
   - **Name:** `github-marketplace`
   - **Audience:** `api://AzureADTokenExchange`
4. Click **Add**.

(Microsoft's page for this: <https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity>. The ids come from this repository's GitHub setting, read on 2026-10-18; they change only if the repository is deleted and recreated. The environment form of the subject is inferred from GitHub's documented branch form.)

If the first publish fails at sign-in, the run log shows the subject GitHub sent. Tell me, or paste that value into the credential's Subject identifier field.

## Part 3: tell GitHub which identity to use (3 minutes)

1. In Azure, on the identity's **Overview** page, copy the **Client ID**. Open **Properties** and copy the **Tenant ID**. (These are identifiers, not secrets.)
2. Open <https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/settings/environments> and click **marketplace**.
3. Under **Environment variables** click **Add variable**. Add `AZURE_CLIENT_ID` (the Client ID) and `AZURE_TENANT_ID` (the Tenant ID).

Terminal alternative:

```bash
gh variable set AZURE_CLIENT_ID --env marketplace --repo SureForgeTech/filemaker-data-api-for-vs-code --body "<client id>"
gh variable set AZURE_TENANT_ID --env marketplace --repo SureForgeTech/filemaker-data-api-for-vs-code --body "<tenant id>"
```

## Part 4: get the identity's Azure DevOps id (I do this; you approve once)

The Marketplace identifies the identity by an id that only the identity itself can read. Reply "run the id helper" once Parts 1 to 3 are done. I will then:

1. Temporarily allow the `main` branch on the `marketplace` environment (it is normally tags only; the helper cannot run from a branch otherwise).
2. Start the **Entra identity id** workflow.
3. You get a GitHub notification: open the run, click **Review deployments**, tick **marketplace**, **Approve and deploy**.
4. I read the id from the run log, remove the temporary branch rule, and send you the id.

## Part 5: allow that identity to publish (3 minutes)

1. Open <https://marketplace.visualstudio.com/manage> and click the **SureForgeTech** publisher.
2. Open **Members** and **Add**.
3. Paste the id from Part 4, set the role to **Contributor**, save. **(unconfirmed: the exact button labels; Microsoft names the Contributor role but shows no screenshot for this step.)**

Microsoft's description of this step: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension> (the Microsoft Entra ID section).

## Part 6: publish

Push the `v*` tag. In the run, approve the **marketplace** deployment. The `publish` job signs in with the identity and publishes. **If it fails at the publish step with an access error, tell me the message** so I can fix it: this flow is documented by Microsoft only for Azure Pipelines, and reported working on GitHub Actions by one third-party write-up, not by Microsoft.

## Afterwards

- I delete the helper workflow (`entra-identity-id.yml`) once Part 5 is done.
- There is no `VSCE_PAT` anywhere and nothing to renew.

## Pitfalls

- The subject in Part 2 must match exactly (including `marketplace`); a mismatch is accepted when you save and fails silently at sign-in.
- Use a **user-assigned managed identity**, not an "app registration". A third-party report says an app registration signs in but fails at the publish step.
- The id pasted in Part 5 must be the one from Part 4, not the Client ID.
- Do this before 1 December 2026 if you want automatic publishing to keep working.

## Later option

`vsce` 4.0.0 also has a hidden `--oidc` option (GitHub sign-in straight to the Marketplace, no Azure at all). It is not in Microsoft's documentation and I could not find how a publisher turns it on, so it is not used. If Microsoft documents it, it would replace Parts 1 to 5.
