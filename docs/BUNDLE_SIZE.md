# VSIX bundle size budget

The CI step `Enforce VSIX size budget` (in `.github/workflows/ci.yml`) caps the packaged VSIX. Current budget: **5 MiB** (`VSIX_BUDGET_BYTES`).

## Why

Marketplace download speed matters most on constrained networks (mobile tethers, corporate proxies, VPNs). The cap prevents accidental bloat: committing `node_modules`, leaving a large debug payload in the bundle, or adding a binary asset by mistake.

The cap is generous. At v1.1.0 the VSIX was about 1.0 MB, with inline source maps about 1.7 MB, so 5 MiB leaves room for legitimate growth (new features, webview assets) without tripping the gate before there is a real discussion to have.

## Raising the cap

If a legitimate need pushes the VSIX over the budget, raise `VSIX_BUDGET_BYTES` in its own pull request with a one-line reason in the commit message, for example:

```
ci(budget): raise VSIX cap to 8 MiB

The layout designer webview adds about 3 MB of assets; trimming to fit
under 5 MiB needs code splitting. Raise the cap for this release and
tighten it again after the split.
```

The cap lives in the workflow file, so it is reviewed like any other change. Update this page with the new number.

## Trimming first

Before raising it, ask whether the size is avoidable:

- Source maps add about 60%. Switching from `--sourcemap=inline` to external maps and excluding `.map` files with `.vscodeignore` removes them (see "Source maps" in [RELEASE.md](./RELEASE.md)).
- Webview bundles can load chunks lazily.
- Large vendored dependencies are candidates for esbuild `--external`.
- Look for files `.vscodeignore` misses: `npx @vscode/vsce ls --tree` from `extension/`.

`npm run package:check` runs the same packaging path locally, so the size effect of a change is visible before you push. The VSIX also ships everything under `extension/docs/`, so keep documentation lean.
