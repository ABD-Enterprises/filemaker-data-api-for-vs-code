# Job aid: set up token-free publishing with Microsoft Entra ID

**Why:** Azure DevOps personal access tokens (what `vsce` used) stop working on **1 December 2026**. This setup lets GitHub publish to the Marketplace with a short-lived sign-in instead, so there is no token to create, store or renew.
**Time:** about 20 minutes, once. **Cost:** free (managed identities and federated credentials have no charge).
**Checked against current docs on 2026-10-18.** Where a step could not be confirmed from Microsoft's documentation it is marked **(unconfirmed)**; the first real publish is the test.

If anything here fails, you can still release by uploading the `.vsix` by hand at <https://marketplace.visualstudio.com/manage>. Nothing in this setup blocks that.

## What you need

- The Microsoft account that owns the `SureForgeTech` publisher.
- An Azure account with a subscription (the free account is enough): <https://azure.microsoft.com/free>. You need it only to create the identity; the identity itself needs no Azure permissions.
- Admin on the GitHub repo (you are).

## Part 1: create the identity in Azure (5 minutes)

1. Go to <https://portal.azure.com> and sign in.
2. In the top search box type **Managed Identities** and open it, then click **+ Create**.
3. Choose your subscription, create or pick a resource group (for example `publishing`), pick any region, and name it `vsce-publisher`. Click **Review + create**, then **Create**.
4. When it finishes click **Go to resource**.

## Part 2: let only the `marketplace` environment use it (5 minutes)

In the identity's page:

1. In the left menu open **Settings > Federated credentials**, then **+ Add credential**.
2. **Federated credential scenario:** GitHub Actions deploying Azure resources.
3. **Organization:** `SureForgeTech`. **Repository:** `filemaker-data-api-for-vs-code`.
4. **Entity type:** Environment. **Environment name:** `marketplace` (exactly).
5. **Name:** `github-marketplace`. Click **Add**.

(Microsoft's page for this: <https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity>.)

## Part 3: tell GitHub which identity to use (3 minutes)

1. In Azure, on the identity's **Overview** page, copy the **Client ID**. Open **Properties** and copy the **Tenant ID**. (These are identifiers, not secrets.)
2. Open <https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/settings/environments> and click **marketplace**.
3. Under **Environment variables** click **Add variable**. Add `AZURE_CLIENT_ID` (the Client ID) and `AZURE_TENANT_ID` (the Tenant ID).

Terminal alternative:

```bash
gh variable set AZURE_CLIENT_ID --env marketplace --repo SureForgeTech/filemaker-data-api-for-vs-code --body "<client id>"
gh variable set AZURE_TENANT_ID --env marketplace --repo SureForgeTech/filemaker-data-api-for-vs-code --body "<tenant id>"
```

## Part 4: get the identity's Azure DevOps id (3 minutes)

The Marketplace identifies the identity by an id that only the identity itself can read, so a small helper workflow reads it.

1. Open <https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/actions/workflows/entra-identity-id.yml> and click **Run workflow**.
2. The run waits for your approval: click **Review deployments**, tick **marketplace**, click **Approve and deploy**.
3. Open the finished run, the **Print the Azure DevOps id** step. Copy the one line it prints (a UUID).

## Part 5: allow that identity to publish (3 minutes)

1. Open <https://marketplace.visualstudio.com/manage> and click the **SureForgeTech** publisher.
2. Open **Members** and **Add**.
3. Paste the UUID from Part 4, set the role to **Contributor**, save. **(unconfirmed: the exact button labels; Microsoft names the Contributor role but shows no screenshot for this step.)**

Microsoft's description of this step: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension> (the Microsoft Entra ID section).

## Part 6: publish

Push the `v*` tag. In the run, approve the **marketplace** deployment. The `publish` job signs in with the identity and publishes. **If it fails at the publish step with an access error, tell me the message** so I can fix it: this flow is documented by Microsoft only for Azure Pipelines, and reported working on GitHub Actions by one third-party write-up, not by Microsoft.

## Afterwards

- You can delete the helper workflow (`entra-identity-id.yml`) once Part 5 is done.
- There is no `VSCE_PAT` anywhere and nothing to renew.

## Pitfalls

- The environment name in Part 2 must match `marketplace` exactly; a mismatch fails silently at sign-in.
- Use a **user-assigned managed identity**, not an "app registration". A third-party report says an app registration signs in but fails at the publish step.
- The id pasted in Part 5 must be the one from Part 4, not the Client ID.
- Do this before 1 December 2026 if you want automatic publishing to keep working.
