# Step 1 — Add a connection profile

A **connection profile** stores how to reach your FileMaker server and which
database to talk to. Passwords are stored in your OS keychain via VS Code's
SecretStorage — they never sit on disk in plain text.

Click the **Add Profile** button or run **FileMaker: Add Connection Profile**
from the Command Palette (`Ctrl/Cmd+Shift+P`). The connection wizard opens
in an editor tab. You'll need:

- **Server URL** — e.g. `https://fm.example.com`
- **Database name** — the name of the file on the server (without `.fmp12`)
- **Auth mode** — `Direct` for username + password against the Data API, or
  `Proxy` if your team runs a relay
- **API base path** and **version** are pre-filled to the FileMaker defaults
  (`/fmi/data` + `vLatest`) — leave them alone unless your admin says otherwise

Click **Test Connection** before saving. The wizard shows a colored badge
inline so you know whether the credentials work without leaving the page.

> **Tip:** Profiles are scoped per workspace by default. If you want one
> profile available everywhere, change `filemaker.savedQueries.scope` after
> saving.
