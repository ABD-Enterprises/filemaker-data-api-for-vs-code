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

The shipped bundles (`dist/extension.js`, the schema-diff worker and the MCP shim) are minified
and carry **no source map**. `scripts/esbuild-config.mjs` writes an *external* map next to each
bundle (`dist/*.js.map`), and `.vscodeignore` keeps `dist/**/*.map` out of the VSIX. The Layout
Mode UI is built minified with no map at all.

The tagged `package` job in `.github/workflows/ci.yml` collects the maps from the very build that
produced the VSIX into `sourcemaps-<tag>.tgz`, and the `release` job attaches it to the GitHub
release next to the VSIX. To symbolicate a stack trace from a user report, download that asset
for the same tag, unpack it, and point your tool (for example `source-map-support` or a browser
devtools "add source map") at `dist/extension.js.map`. A map only matches the exact build it
came from, so always use the asset from the tag the user reported.

## Cut a release

(Full runbook — see issue #140 for the complete step-by-step.)

1. Branch from green main: `git checkout -b release/vX.Y.Z`
2. Bump `extension/package.json` version
3. Add a CHANGELOG section under `## X.Y.Z`
4. PR, CI green, merge
5. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z — <theme>"` then `git push origin vX.Y.Z`
6. CI's `package` + `publish` jobs build the VSIX and publish to Marketplace
7. Promote the GitHub release from draft to Latest
8. Verify Marketplace shows new version (~5 min after publish)

## After publish

- Re-attach the CI-built VSIX to the GitHub release if needed
- Post announcement in Discussions / social per issue #147
- Update any external docs that mention the previous version
