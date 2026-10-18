# FM Web reference

Reference for the FM Web workflow (Layout Mode, generated Next.js runtime and the local bridge). For the steps a user follows, see [FM Web and Layout Mode](./USER_GUIDE.md#fm-web-and-layout-mode) in the user guide. FM Web is experimental.

## Architecture

Four layers:

1. VS Code extension services (`fmWebProjectService`, `fmWebRuntimeGenerator`, `fmBridgeServer`).
2. The Layout Mode webview (the designer, from `designer-ui/`).
3. The generated Next.js runtime (`.fmweb/generated/runtime-next`, from `runtime-next/`).
4. The shared renderer and schema package (`@fmweb/shared`, from `shared/`).

Flows:

- **Layout authoring:** the webview edits `LayoutDefinition` JSON in `.fmweb/layouts`.
- **Metadata sync:** the extension pulls layouts, fields and script names into `.fmweb/metadata`.
- **Runtime generation:** the extension copies the template app and the generated layout artifacts into `.fmweb/generated`. Generated files are deterministic and existing user-customized files are skipped.
- **Live data:** the Next.js app calls the extension's localhost bridge (`/fm/*`) for record and script operations. It keeps the found set and current record in session state and carries the record context between web layouts.

Design constraints: webviews never reach FileMaker directly; credentials never leave VS Code SecretStorage (only `FMClient` and `ProxyClient` read them); the bridge binds to localhost only.

## Project paths

| Path | Contents |
| --- | --- |
| `.fmweb/layouts` | Authored layout definitions |
| `.fmweb/metadata` | Synced FileMaker metadata cache |
| `.fmweb/generated/runtime-next` | Generated runtime app (its `.env.local` holds only the bridge URL) |
| `.fmweb/generated/layouts` | Generated runtime layout artifacts |

## Layout schema

`LayoutDefinition` is versioned and validated with Zod (`extension/src/fmweb/layoutSchema.ts`).

Top level: `schemaVersion`, `id`, `name`, `fmLayoutName`, `canvas { width, height, gridSize }`, `objects[]`, `styles`.

Object types: `field`, `text`, `button`, `portal`, `rectangle`, `image`, `tabPanel`.

Every object may carry a `behavior`: `runScript`, `goToWebLayout`, `goToFmLayout`, `openUrl` or `showDialog`, with the extra fields `scriptName`, `targetLayoutId`, `targetFmLayoutName`, `url`, `dialogId` and `parameter`.

`migrateLayoutDefinition` migrates older schema versions to the current one. A newer, unknown schema version is rejected rather than parsed down-level.

## Bridge security

The bridge (`fmBridgeServer`) is started by **FileMaker: Start FM Web Preview Server**. It:

- binds to `127.0.0.1` on a random port and rejects non-loopback peers;
- requires a trusted workspace;
- requires a 256-bit per-session token in the `X-FM-Bridge-Token` header, generated when the bridge starts and discarded when it stops;
- accepts only `localhost` and `127.0.0.1` origins and JSON `POST` requests to `/fm/*` with validated payloads;
- caps the request body at 1 MB and applies a token-bucket rate limit and a per-session request budget (`filemaker.fmWeb.bridge.*` settings; throttled requests get HTTP 429 with `Retry-After`);
- serves only the active connection and rejects a request that names another profile;
- applies the same policy as the user's own commands: writes (edit, create, delete) and script runs are refused in offline mode, script runs are refused when the script runner is switched off, and both are refused when enterprise policy disallows them.

The bridge never returns secrets. Generated `.env.local` contains the bridge URL only. The runtime keeps record context and found-set IDs in session storage, not credentials.

Threats and mitigations in short: remote access (loopback binding and socket check), cross-site requests (origin allow-list, JSON only, token), untrusted workspace content (trust required; the preview asks before it runs `npm install` and `npm run dev`), credential leakage (secrets stay in `FMClient`), resource exhaustion (body cap, rate limit, budget). Any local process that obtains the token can use the bridge as the runtime does; the token lives only in extension host memory.

Known gap in this release: the runtime's bridge client (`runtime-next/lib/bridge-client.ts`) does not send `X-FM-Bridge-Token`, and the extension does not pass the token to the runtime, so bridge calls from the generated app are rejected with HTTP 403. The user guide lists this as a known gap.

## Develop and test

```bash
npm ci                # repository root
npm run build
npm run typecheck
npm test
npm run lint
```

Press `F5` to open an Extension Development Host and run the FM Web commands from the Command Palette: **Initialize FM Web Project**, **Select Active Profile**, **Sync FM Web Project Metadata**, **Open FM Web Layout Mode**, **Generate FM Web Next.js App**, **Generate FM Web Layout Page**, **Start FM Web Preview Server**.
