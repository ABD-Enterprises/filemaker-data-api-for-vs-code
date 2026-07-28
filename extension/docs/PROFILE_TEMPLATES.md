# Profile Templates

Workspace profile templates pre-fill the Add Connection Profile wizard from a local JSON file:

```text
.filemaker/profile-template.json
```

Supported fields:

```json
{
  "name": "Team Development",
  "authMode": "direct",
  "serverUrl": "https://fm-dev.example.com",
  "database": "TeamApp",
  "apiBasePath": "/fmi/data",
  "apiVersionPath": "vLatest",
  "username": "developer",
  "locked": true
}
```

Use `"authMode": "proxy"` with `"proxyEndpoint"` instead of `"username"` for middleware-backed profiles.

Templates must not contain credentials. `password`, `proxyApiKey`, session tokens, bearer tokens, API keys, and unsupported fields cause the template to be ignored with a non-fatal warning. Developers still enter their own secrets in the wizard, and secrets continue to be stored only in VS Code SecretStorage.

When `"locked": true`, the wizard marks `serverUrl`, `database`, `apiBasePath`, and `apiVersionPath` as locked and read-only. User-specific fields such as `username` and `proxyEndpoint` remain editable.
