# Devcontainer for FileMaker Data API Tools

This directory configures a [Dev Container](https://containers.dev/) so
evaluators and contributors can spin up a working environment without
local setup.

## Open in GitHub Codespaces

From the repo page, click **Code → Codespaces → Create codespace on
main**. Codespaces provisions the container, installs the extension
from the Marketplace, and opens VS Code in your browser. From there:

1. Run **FileMaker: Add Connection Profile** (extension preinstalled).
2. Point it at any reachable FileMaker Server you have access to, or
   the public demo sandbox once it's online (issue #168).
3. Run **FileMaker: Connect** → query.

Total time from "Create codespace" to "querying FileMaker": **~60
seconds** on Codespaces' default 2-core machine.

## Open locally with VS Code's Dev Containers extension

1. Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).
2. Clone this repo, open in VS Code.
3. Command Palette → **Dev Containers: Reopen in Container**.

The container is the same as Codespaces (`mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm`).

## What's preinstalled

- Node.js 20 (matches the CI runner)
- Git, GitHub CLI (`gh`)
- This extension (`deffenda.filemaker-data-api-tools`) from the
  Marketplace, latest published version

`npm install` runs automatically after container creation so the
monorepo workspaces are ready for `npm test`, `npm run build`, etc.

## What's NOT preinstalled

- A FileMaker Server. You supply your own server URL + credentials at
  profile-creation time. The demo sandbox (#168) will replace this
  requirement when it's online.
- A model CLI credential (e.g. `codex --login`) if you intend to run the
  ORC ticket loop from inside the container. Governance for this repo is
  ORC (see `CLAUDE.md` / `AGENTS.md`); the loop runs via the ORC engine,
  not a per-repo GitHub Actions agent.

## Updating the container

Edit `devcontainer.json` in a PR. CI runs lint and typecheck against
the updated image to catch breakage.

## Troubleshooting

**Extension is not present after container builds**: Codespaces sometimes
silently skips the `extensions` install if the Marketplace is unreachable
during build. Reload the window (`Developer: Reload Window`) and the
extensions reinstall from cache.

**`npm install` failed during postCreateCommand**: open a terminal in the
container and run `npm install` manually. Most failures are npm registry
flakiness and clear on retry.
