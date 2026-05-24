# Issue 177 Local Validation

- `ai-pipeline validate --id 177`: passed; no `validation.local` commands declared.
- `npm run lint -w extension`: passed.
- `npm run typecheck`: passed across `shared`, `designer-ui`, `runtime-next`, and `extension`.
- `npm test`: passed across `designer-ui` (6 files, 15 tests), `runtime-next` (3 files, 9 tests), and `extension` (79 files, 450 tests).
- `npm run build -w shared`: passed; prerequisite for designer UI build resolution.
- `npm run build -w extension`: passed.
