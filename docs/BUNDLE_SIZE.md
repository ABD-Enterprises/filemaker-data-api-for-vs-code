# VSIX bundle size budget

The CI `Enforce VSIX size budget` step (in `.github/workflows/ci.yml`)
hard-caps the packaged VSIX. Current budget: **5 MiB**.

## Rationale

Marketplace download speed matters most on constrained networks (mobile
tethers, corporate proxies, locked-down VPNs). The hard cap prevents
accidental bloat — e.g., committing `node_modules`, leaving a 100 MB
debug payload in the bundle, or adding a binary asset by mistake.

The cap is set generously: at v1.1.0, the actual VSIX is ~1.0 MB. The 5
MiB ceiling is **5x current** so legitimate growth (new
features, webview assets) doesn't trip the gate before there's a real
discussion to have.

## Raising the cap

If a legitimate need pushes the VSIX over the budget, raise the cap in
its own PR with a one-line rationale in the commit message:

```
ci(budget): raise VSIX cap to 8 MiB

Adding the layout designer webview adds ~3 MB of React + monaco assets;
trimming to fit under 5 MiB would require code-splitting work tracked
in #172. Raise the cap explicitly for this release; tighten back after
#172 lands.
```

The cap living in the workflow file means it's reviewable like any
other code change — no silent drift.

## Trimming the bundle (alternative)

Before raising, ask whether the size is unavoidable:

- Source maps are already external and excluded from the VSIX (`dist/**/*.map` in
  `.vscodeignore`); they are published as a release asset instead (see `docs/RELEASE.md`).
  If the VSIX grows, check that no `.map` file slipped into `vsce ls`.
- Webview bundles can lazy-load chunks (see #172).
- Large vendored dependencies are candidates for `--external:` flags.
- Verify nothing is sneaking in via `.vscodeignore` misses (`vsce ls --tree`).

## Related

- Issue #178 — production source maps (now external; the largest single growth driver before)
- Issue #172 — webview code-splitting
- `npm run package:check` runs the same packaging path locally so the
  size impact of a change is visible before pushing.
