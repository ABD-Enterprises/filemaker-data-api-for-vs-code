# Performance budgets

Performance budgets the extension tries to meet. Regressions break CI
where the budget is enforced; informational metrics are tracked but
not gated.

## Activation time

| Stage | Budget | Enforcement |
|---|---|---|
| `activate(ctx)` pure logic | < 500 ms | CI test (`extension/test/perf/activation.test.ts`) |
| Real cold start in a VS Code host | < 1500 ms | Manual (until #144 / #157 land an e2e bench) |

VS Code itself measures and publishes activation times for every
installed extension; users see the breakdown via **Help → About** →
**Show running extensions** or the "Extension Bisect" tooling. Slow
extensions get flagged in the public marketplace metrics. The 500 ms
budget here is the in-process Node parse + `activate()` work, not the
real cold start — see the test file's docstring for why these numbers
differ from what a user sees.

## Investigating a regression

If the `activate(ctx) returns under the budget` test fails on a PR:

1. **Reproduce locally**: `npm test -- test/perf/activation.test.ts`.
2. **Bisect against `main`**: `git checkout main && npm test -- ...`
   confirms the budget passes there.
3. **Identify the change**: `git log -- src/extension.ts` and any
   service module the activation path touches.
4. **Categorize**: is the change adding work, OR is it legitimate
   feature work that has to happen on the activation path?
   - **Adding incidental work**: defer it — move to first-use lazy load
     (#173 lazy-loads fmClient as a reference example).
   - **Legitimate activation work**: open a PR that raises the
     `ACTIVATE_BUDGET_MS` constant in
     `extension/test/perf/activation.test.ts` with a one-line rationale
     in the commit message. The budget becomes the new SLO.
5. **If real cold start is the issue (user-reported), not the test**:
   add a profiling sample via VS Code's built-in profiler (Developer:
   Show Running Extensions → start profile → reload).

## VSIX bundle size

Tracked in [BUNDLE_SIZE.md](./BUNDLE_SIZE.md) (issue #155). Bundle size
correlates with cold-start time on first install — VS Code downloads
+ extracts the VSIX before activation runs.

## Related work in flight

- #144 — full @vscode/test-electron e2e runner (would let us measure
  real cold start, not just the in-process slice)
- #157 — same path: e2e infrastructure
- #172 — webview code-splitting (improves first-paint of UI panels,
  not activation itself)
- #173 — lazy-load fmClient on first Connect (directly improves
  activation, especially on the no-FM-yet first-run)

## Why this layer exists alongside the VS Code marketplace metrics

The marketplace numbers tell us when we're slow; they don't catch the
PR that introduced the slowdown. A failing test on the introducing PR
is the cheapest place to catch a regression — much cheaper than a
post-release user complaint that requires a patch release to fix.
