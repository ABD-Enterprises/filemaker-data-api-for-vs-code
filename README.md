# FileMaker Data API Tools for VS Code

A free, open-source VS Code extension for the FileMaker Data API. Full CRUD, query building, schema management, batch operations, and more — all from within VS Code.

**[Extension README](extension/README.md)** | **[Support](SUPPORT.md)** | **[Roadmap](docs/roadmap.md)** | **[Architecture](extension/ARCHITECTURE.md)** | **[Contributing](extension/CONTRIBUTING.md)**

## Monorepo Structure

| Package | Description |
|---------|------------|
| `extension/` | VS Code extension — FileMaker Data API Tools v1.0.0 |
| `shared/` | Shared schema, types, and UI renderer utilities |
| `designer-ui/` | React webview app for Layout Mode |
| `runtime-next/` | Next.js runtime template for generated apps |

## Quick Start

```bash
npm install
npm run build
npm test
```

Launch the extension:
1. Open this repo in VS Code.
2. Press `F5` to open the Extension Development Host.
3. Run **FileMaker: Add Connection Profile** from Command Palette.

## Commands

| Command | Description |
|---------|------------|
| `npm run build` | Build all workspace packages |
| `npm run dev` | Run workspace dev commands in parallel |
| `npm run dev:extension` | Dev mode for extension only |
| `npm test` | Run tests across all workspaces |
| `npm run test:coverage` | Run tests with coverage reporting |
| `npm run typecheck` | Type-check all workspaces |
| `npm run lint` | Lint all workspaces |
| `npm run package:check` | Validate VSIX packaging |

## Extension Packaging

```bash
npm run package:check
```

This runs `vsce package` validation from the `extension/` workspace.

## License

MIT
