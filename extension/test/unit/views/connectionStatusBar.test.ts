import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  ConnectionStatusBar,
  computeConnectionStatus
} from '../../../src/views/connectionStatusBar';
import type { ConnectionProfile } from '../../../src/types/fm';

describe('computeConnectionStatus', () => {
  it('renders the disconnected state with a clear CTA tooltip', () => {
    const model = computeConnectionStatus(undefined);
    expect(model.text).toBe('$(circle-outline) FileMaker: Not connected');
    expect(model.tooltip).toContain('No active FileMaker profile');
    expect(model.tooltip).toContain('Click for actions');
  });

  it('renders the connected state with the profile name and database', () => {
    const model = computeConnectionStatus({
      name: 'Production',
      database: 'Contacts'
    });
    expect(model.text).toBe('$(plug) FileMaker: Production');
    expect(model.tooltip).toContain('Connected to Production');
    expect(model.tooltip).toContain('Contacts');
  });

  it('uses different icons for connected vs disconnected so users can distinguish at a glance', () => {
    const disc = computeConnectionStatus(undefined);
    const conn = computeConnectionStatus({ name: 'Dev', database: 'D' });
    expect(disc.text).toContain('$(circle-outline)');
    expect(conn.text).toContain('$(plug)');
    expect(disc.text).not.toBe(conn.text);
  });

  it('puts the profile name in the visible label so reload/restart shows current state', () => {
    // The whole point of this status bar item — it persists across reloads
    // and the user can tell at a glance which profile is active without
    // re-running Connect "to be sure".
    const model = computeConnectionStatus({ name: 'Staging-EU', database: 'Sales' });
    expect(model.text).toContain('Staging-EU');
  });
});

describe('ConnectionStatusBar updates', () => {
  beforeEach(() => vi.clearAllMocks());

  function setup() {
    let activeProfileId: string | undefined = 'p1';
    const pending = new Map<string, (value: ConnectionProfile | undefined) => void>();
    const getProfile = vi.fn(
      (id: string) =>
        new Promise<ConnectionProfile | undefined>((resolve) => {
          pending.set(id, resolve);
        })
    );
    const bar = new ConnectionStatusBar({
      getActiveProfileId: () => activeProfileId,
      getProfile
    } as never);
    const item = vi.mocked(vscode.window.createStatusBarItem).mock.results.at(-1)
      ?.value as vscode.StatusBarItem;
    function finish(id: string, name: string) {
      pending.get(id)?.({ id, name, database: 'Contacts' } as ConnectionProfile);
    }
    return {
      bar,
      item,
      getProfile,
      finish,
      setActive: (id?: string) => {
        activeProfileId = id;
      }
    };
  }

  it('does not restore an old connection after disconnecting', async () => {
    const { bar, item, finish, setActive } = setup();
    setActive(undefined);
    bar.refresh();
    finish('p1', 'Old');
    await Promise.resolve();
    expect(item.text).toBe(computeConnectionStatus(undefined).text);
    bar.dispose();
  });

  it('keeps the newest profile when earlier requests finish later', async () => {
    const { bar, item, finish, setActive } = setup();
    setActive('p2');
    bar.refresh();
    finish('p2', 'New');
    await Promise.resolve();
    finish('p1', 'Old');
    await Promise.resolve();
    expect(item.text).toBe('$(plug) FileMaker: New');
    bar.dispose();
  });

  it('does not write to a disposed status item', async () => {
    const { bar, item, finish, getProfile } = setup();
    bar.dispose();
    const textAtDisposal = item.text;
    finish('p1', 'Old');
    await Promise.resolve();
    bar.refresh();
    expect(item.text).toBe(textAtDisposal);
    expect(getProfile).toHaveBeenCalledTimes(1);
  });

  it('settles the loading state when the profile lookup fails', async () => {
    const getProfile = vi.fn().mockRejectedValue(new Error('Storage unavailable'));
    const bar = new ConnectionStatusBar({ getActiveProfileId: () => 'p1', getProfile } as never);
    await Promise.resolve();
    const item = vi.mocked(vscode.window.createStatusBarItem).mock.results.at(-1)
      ?.value as vscode.StatusBarItem;
    expect(item.text).toBe(computeConnectionStatus(undefined).text);
    bar.dispose();
  });
});
