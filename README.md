# FileMaker Data API Tools for VS Code

A free, open-source VS Code extension for the FileMaker Data API: connect, query, edit records, compare schemas, export and update in batches, generate TypeScript types, and (optionally, off by default) give AI tools safe access. MIT licensed, no telemetry.

Install it from the Marketplace: search for **FileMaker Data API Tools** (publisher SureForgeTech), or run `code --install-extension SureForgeTech.filemaker-data-api-tools`.

## Documentation

| I want to... | Read |
| --- | --- |
| Use the extension | [User Guide](extension/docs/USER_GUIDE.md) |
| Check which FileMaker versions work | [Compatibility](extension/docs/COMPATIBILITY.md) |
| Upgrade between versions | [Upgrade notes](extension/UPGRADE.md) and the [Changelog](extension/CHANGELOG.md) |
| Understand security and data handling | [Security overview](docs/security.md), [Data handling](docs/DATA_HANDLING.md) |
| Report a vulnerability | [Security policy](SECURITY.md) |
| Contribute code or docs | [Contributing](extension/CONTRIBUTING.md), [Architecture](extension/ARCHITECTURE.md), [API reference](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/api/) |
| Cut a release | [Release process](docs/RELEASE.md), [cadence](docs/RELEASE_CADENCE.md), [rollback](docs/ROLLBACK.md) |
| Understand a design decision | [Architecture decision records](docs/ADR/README.md) |

The Marketplace page is [extension/README.md](extension/README.md).

## Repository layout

| Folder | Contents |
| --- | --- |
| `extension/` | The VS Code extension (published as `SureForgeTech.filemaker-data-api-tools`) |
| `shared/` | Shared schema, types and renderer utilities |
| `designer-ui/` | React webview app for FM Web Layout Mode |
| `runtime-next/` | Next.js runtime template for generated FM Web apps |
| `docs/` | Maintainer, security and release documentation |
| `tools/` | Release helpers (`release-notes.sh`, the pinned `vsce` install) |

## Develop

Node.js 22 or newer is required.

```bash
npm ci
npm run build
npm test
```

Press `F5` in VS Code to open an Extension Development Host, then run **FileMaker: Add Connection Profile**. No FileMaker server? Run `npm run mock:server -w extension` and point a profile at the mock Data API described in [CONTRIBUTING.md](extension/CONTRIBUTING.md).

Useful root scripts: `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run docs:api` (TypeDoc into `docs/api`), `npm run package:check` (run `npm run build` first; builds a VSIX into `artifacts/` and validates it). See [Contributing](extension/CONTRIBUTING.md) for the full checklist.

## License

MIT. See [LICENSE](LICENSE).
