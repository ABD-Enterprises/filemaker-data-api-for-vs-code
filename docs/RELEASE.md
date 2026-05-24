# Release process

This is the canonical runbook for cutting a release. Companion to the
release-cadence policy (issue #153) and the rollback playbook (issue #141).

## Versioning

Follow semver, interpreted for a VS Code extension:

- **Patch (`1.1.x`)** — bug fixes, doc-only changes, dependency bumps that
  don't change behavior.
- **Minor (`1.x.0`)** — new features, new settings, new walkthroughs,
  new commands. Backward-compatible.
- **Major (`x.0.0`)** — breaking changes: removed commands, removed
  settings (without a migration), schema-snapshot format changes that
  invalidate prior snapshots. Document the migration path in UPGRADE.md
  before cutting.

## Source maps

Production VSIX ships **inline source maps** (via
`esbuild --sourcemap=inline` in the `bundle:extension` script). Trade-off:
the VSIX grows from ~1.0 MB to ~1.7 MB (+60%). The benefit is that any
user-reported stack trace points at real source file:line positions
without us having to publish or fetch separate .map files.

If size becomes a real concern (e.g., for Marketplace download speed in
constrained networks), switch to external maps and exclude them from the
VSIX:

```diff
- "bundle:extension": "esbuild ... --sourcemap=inline --outfile=dist/extension.js"
+ "bundle:extension": "esbuild ... --sourcemap=external --outfile=dist/extension.js"
```

Then add `dist/extension.js.map` to a separate release artifact and add it
to `.vscodeignore`. Update this section when you do.

## Cut a release

(Full runbook — see issue #140 for the complete step-by-step.)

1. Branch from green main: `git checkout -b release/vX.Y.Z`
2. Bump `extension/package.json` version
3. Update the What's New walkthrough for the new version:
   - add or update the version entry in `extension/src/extension.ts`
     (`WHATS_NEW_RELEASES`)
   - add a matching `contributes.walkthroughs` entry in
     `extension/package.json`
   - add 3-5 walkthrough markdown files under
     `extension/docs/walkthroughs/whats-new-X.Y.Z/`, each with a screenshot
   - verify **FileMaker: Show What's New** opens the new walkthrough
4. Add a CHANGELOG section under `## X.Y.Z`
5. PR, CI green, merge
6. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z — <theme>"` then `git push origin vX.Y.Z`
7. CI's `package` + `publish` jobs build the VSIX and publish to Marketplace
8. Promote the GitHub release from draft to Latest
9. Verify Marketplace shows new version (~5 min after publish)

## After publish

- Re-attach the CI-built VSIX to the GitHub release if needed
- Post announcement in Discussions / social per issue #147
- Update any external docs that mention the previous version
