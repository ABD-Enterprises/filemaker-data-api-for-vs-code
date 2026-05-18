# Security and Trust Model

This document captures the trust boundaries inside the FileMaker Data API
Tools extension and what each boundary protects (or doesn't).

## Connection profiles

A connection profile contains a server URL, database name, auth mode,
and either a username (direct auth) or a proxy endpoint (proxy auth).
Passwords, session tokens, and proxy API keys are stored separately in
`SecretStore`, which prefers VS Code's `SecretStorage` (OS keychain)
and falls back to an encrypted Memento when SecretStorage is
unavailable. See `filemaker.secrets.fallback` setting.

## Direct mode

In direct mode the extension talks straight to the FileMaker Data API
using Basic auth on `POST /sessions` and a Bearer token on subsequent
requests. The trust boundary is the user's FileMaker credentials and
the TLS connection to the server. There is no third party in the
request path.

## Proxy mode

When `authMode = 'proxy'`, the extension posts every action to a
user-configured proxy endpoint. The proxy then authenticates to
FileMaker on the user's behalf, typically using a service account or
delegated credentials it manages internally. The extension itself
never sees those credentials in proxy mode.

### Payload sent to the proxy

For each action, the extension sends the minimum profile fields the
proxy needs to route the request:

```json
{
  "action": "<action-name>",
  "profile": {
    "id": "<profile-id>",
    "database": "<database>",
    "serverUrl": "<https://fm.example.com>",
    "apiBasePath": "/fmi/data",
    "apiVersionPath": "vLatest"
  },
  "payload": { ... }
}
```

Notable omissions:

- The human-readable `name` is **not** sent. Proxies identify profiles
  by `id`.
- Authorization for the proxy itself (when configured) is carried in
  the standard `Authorization: Bearer <proxyApiKey>` header, not in
  the body.

### What a compromised proxy can see

A proxy in the request path has the same FileMaker access as the
configured proxy auth principal. That means:

1. **Every action's payload** (find queries, record edits, script
   invocations) passes through the proxy in cleartext as far as the
   proxy is concerned — TLS to the proxy is necessary but not
   sufficient.
2. **The proxy's account is the trust anchor** for whatever it can
   read or write in FileMaker. Restrict proxy accounts to the
   minimum privileges per environment (read-only proxies for
   read-only deployments, separate accounts per database where
   feasible).
3. **The proxy can replay or alter requests** between receipt and
   forwarding. Treat the proxy host as part of the FileMaker security
   perimeter.

### Mitigations

- Keep the proxy on infrastructure you operate; do not point at
  third-party hosted relays for production data.
- Rotate the proxy API key (`SecretStore` proxy key) on a regular
  cadence; the extension picks up rotated keys automatically.
- Restrict proxy ingress to known client IPs / VPN.
- Audit-log proxy actions on the proxy itself; the extension cannot
  see proxy-side logs.

## Local bridge server (`FmBridgeServer`)

When the FM Web project workflow is in use, the extension starts a
local HTTP server bound to `127.0.0.1` (random port) and gates every
request with:

1. **Workspace trust**: untrusted workspaces are rejected outright.
2. **Localhost socket check**: non-loopback peers are rejected.
3. **Per-session bridge token**: a 256-bit random token must be sent
   in the `X-FM-Bridge-Token` header. The token is generated on each
   `ensureStarted()` and discarded on `stop()`.
4. **Origin allow-list**: cross-origin requests must come from
   explicitly allowed origins.
5. **Rate limit and request budget** (see `filemaker.fmWeb.bridge.*`
   settings): token-bucket rate limiter + hard per-token-lifetime
   request cap. Throttled requests receive `HTTP 429` with
   `Retry-After`; budget-exhausted clients must restart the bridge.

The trust boundary is **the bridge token + localhost binding**. Any
local process that obtains the token can call the bridge as if it
were the trusted runtime. The token is held only in the extension
host's memory and is not written to disk; rate limiting bounds the
blast radius if it is exfiltrated.

## What the extension does *not* protect against

- **Malicious local processes** on the same machine that can read
  the extension host's memory. This is outside the OS-level threat
  model; rely on the OS / EDR.
- **A compromised proxy host**. See "Proxy mode" above.
- **FileMaker server-side ACLs**. The extension talks the Data API
  and inherits whatever rights the authenticated user has on the
  server. Server admins remain the authority on what data is
  reachable.

## Reporting security issues

If you find a vulnerability, please file a private security advisory
on the GitHub repository rather than a public issue. Include a
proof-of-concept where possible.
