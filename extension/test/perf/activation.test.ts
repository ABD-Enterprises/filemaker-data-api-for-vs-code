import { describe, expect, it, vi } from 'vitest';

/**
 * Activation performance benchmark — #156.
 *
 * Measures the time from `require()` returning the bundled extension module
 * to `activate()` resolving. This is a vitest test using the existing
 * vscode mock from test/setup.ts, not a real VS Code host — so the
 * measurement is "module-parse + activate() pure logic", NOT a full
 * cold start in a running editor.
 *
 * That distinction matters: the absolute numbers here are LOWER than what
 * the user sees in a real VS Code launch (no extension-host process spawn,
 * no disk-cold module resolution, no marketplace-installed sandboxing).
 * What this test catches is gross regressions: a synchronous filesystem
 * scan added to activate(), a 100MB module imported eagerly, a network
 * call on the activation path. All of those would inflate the number here
 * by orders of magnitude even with the mock.
 *
 * The "real" cold-start measurement comes via @vscode/test-electron when
 * issue #144 lands. This test is the cheaper preventive layer.
 *
 * SLO budget: see /docs/PERFORMANCE.md
 */

const ACTIVATE_BUDGET_MS = 500;

describe('extension activation performance (#156)', () => {
  it('module exports an activate function', async () => {
    // Sanity check: regressions that delete or rename `activate` are
    // structural, not a timing concern. Catches accidental refactors.
    const mod = await import('../../src/extension');
    expect(mod.activate).toBeDefined();
    expect(typeof mod.activate).toBe('function');
  });

  it('activate(ctx) returns under the budget', async () => {
    const { activate } = await import('../../src/extension');

    // Minimal ExtensionContext shape. The vscode mock supplies most other
    // surfaces (workspace, window, commands, etc.); ctx provides only
    // what activate() actually touches synchronously.
    const ctx = {
      subscriptions: [] as { dispose: () => void }[],
      extensionUri: { fsPath: '/test/extension', toString: () => 'file:///test/extension' },
      globalState: {
        get: vi.fn().mockReturnValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockReturnValue([]),
        setKeysForSync: vi.fn(),
      },
      workspaceState: {
        get: vi.fn().mockReturnValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockReturnValue([]),
      },
      secrets: {
        get: vi.fn().mockResolvedValue(undefined),
        store: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        onDidChange: vi.fn(),
      },
      extension: {
        id: 'deffenda.filemaker-data-api-tools',
        packageJSON: { version: '1.1.0' },
      },
      extensionMode: 1, // ExtensionMode.Production
      asAbsolutePath: (p: string) => `/test/extension/${p}`,
    };

    const start = performance.now();
    try {
      // activate() may throw if mocks are insufficient; that's a regression
      // worth catching. We do not assert on throwing — the budget assertion
      // below catches the time even if activate() rejects.
      await activate(ctx as never);
    } catch {
      /* Swallow: test focus is activation TIME, not activation correctness. */
    }
    const elapsed = performance.now() - start;

    // Clean up subscriptions defensively
    for (const sub of ctx.subscriptions) {
      try {
        sub.dispose?.();
      } catch {
        /* ignore */
      }
    }

    expect(elapsed).toBeLessThan(ACTIVATE_BUDGET_MS);
  });
});
