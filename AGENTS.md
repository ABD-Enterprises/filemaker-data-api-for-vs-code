## Cursor Cloud specific instructions

### Overview

This is a VS Code extension monorepo (npm workspaces) for **FileMaker Data API Tools**. Four packages:

| Package | Path | Purpose |
|---------|------|---------|
| `shared` | `shared/` | Zod layout schemas + React UI renderer |
| `designer-ui` | `designer-ui/` | React webview for Layout Mode |
| `runtime-next` | `runtime-next/` | Next.js template for generated apps |
| `extension` | `extension/` | The VS Code extension itself |

### Node.js version

Requires **Node.js 20** (see `.nvmrc`). Run `source ~/.nvm/nvm.sh && nvm use 20` before any npm command if the default shell version differs.

### Key commands

All commands documented in the root `README.md` and `extension/CONTRIBUTING.md`. Quick reference:

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Build all | `npm run build` |
| Lint | `npm run lint` (zero warnings enforced) |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Test + coverage | `npm run test:coverage` |
| VSIX package check | `npm run package:check` |
| Dev watch | `npm run dev` |

### Testing

- All tests run headlessly via **Vitest** — no VS Code instance or FileMaker server required.
- HTTP calls are mocked with **nock** in `extension/test/`.
- VS Code APIs are mocked in `extension/test/setup.ts`.
- The `shared` package has no tests; `designer-ui` and `runtime-next` each have their own Vitest suites.

### Build order matters

`shared` must be built before `designer-ui` and `runtime-next` (they depend on `@fmweb/shared`). The root `npm run build` handles this automatically via workspace ordering.

### No external services needed

This is a pure Node.js/TypeScript project. No Docker, databases, or external services are required for building, linting, type-checking, or running tests.
