# Contributing

All contributors are expected to follow the project [Code of Conduct](../CODE_OF_CONDUCT.md).

## Development Setup

```bash
npm install
npm run lint
npm run build
npm test
```

Launch the extension host:
1. Open this repo in VS Code.
2. Press `F5`.
3. Run **FileMaker: Add Connection Profile** in the new window.

## Project Conventions

- TypeScript strict mode is required.
- Avoid `any`; keep explicit types on API responses and message contracts.
- Keep secrets out of settings, state, and logs.
- Use shared utilities:
  - `utils/normalizeError.ts` — error normalization
  - `utils/redact.ts` — credential redaction
  - `utils/errorUx.ts` — command error UX with "Details..." action
  - `services/settingsService.ts` — centralized settings with defaults

## Adding Commands

1. Add command implementation under `src/commands/`.
2. Register in `src/extension.ts`.
3. Add command and menu contributions in `package.json`.
4. Enforce role guard and workspace trust where needed.
5. Add unit and integration tests.

## Adding New Data API Endpoints

1. Add types in `src/types/dataApi.ts` and/or `src/types/fm.ts`.
2. Implement in `src/services/fmClient.ts` using the existing request wrapper.
3. Add proxy passthrough in `src/services/proxyClient.ts`.
4. Propagate `AbortSignal` for cancellation.
5. Normalize errors with `normalizeError()`.
6. Redact sensitive values in logs and error details.
7. Add mocked integration tests in `test/integration/`.

## Testing

- **Unit tests**: pure helpers, stores, services, utilities, commands, tree view
- **Integration tests**: mocked HTTP with `nock` for Data API contract behavior
- **Snapshot tests**: webview HTML structure and CSP validation

Run before submitting:

```bash
npm run lint            # zero warnings enforced
npm run typecheck       # tsc --noEmit
npm test                # vitest
npm run test:coverage   # with coverage reporting
```

## Code Review Checklist

- [ ] No secrets in settings, state, or logs
- [ ] Error paths use `normalizeError()` and `showCommandError()`
- [ ] AbortSignal propagated where applicable
- [ ] Role guard and workspace trust checks in place for write operations
- [ ] Tests added for new functionality
- [ ] Lint, typecheck, and all tests pass
