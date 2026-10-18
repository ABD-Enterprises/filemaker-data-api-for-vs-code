# Performance budgets

Budgets the extension tries to meet. Where a budget is enforced in CI, a regression fails the build; the rest are checked by hand.

## Activation time

| Stage | Budget | Enforcement |
| --- | --- | --- |
| `activate(ctx)` in-process work | under 500 ms | CI test `extension/test/perf/activation.test.ts` (`ACTIVATE_BUDGET_MS`) |
| Real cold start in a VS Code host | under 1500 ms | By hand |

VS Code measures every extension's activation: **Developer: Show Running Extensions** shows the time, and you can profile from there. The 500 ms budget is the in-process work only, not what a user sees on a cold start, so the two numbers differ.

## If the activation test fails on a pull request

1. Reproduce it: `npm test -w extension -- test/perf/activation.test.ts`.
2. Confirm the test passes on `main`.
3. Find the change: `git log -- extension/src/extension.ts` and the services the activation path constructs.
4. Decide: is the change adding incidental work, or legitimate work that has to happen at activation?
   - Incidental: defer it to first use (the Data API client is already loaded lazily).
   - Legitimate: raise `ACTIVATE_BUDGET_MS` in a pull request with a one-line reason. The new value becomes the budget.
5. If users report slow startup but the test passes, profile with the built-in extension profiler.

## VSIX size

See [BUNDLE_SIZE.md](./BUNDLE_SIZE.md). Download and unpack time adds to first-install time.

## Why a test as well as Marketplace metrics

The Marketplace numbers say when the extension is slow, not which pull request made it slow. A failing test on the introducing pull request is the cheapest place to catch a regression.
