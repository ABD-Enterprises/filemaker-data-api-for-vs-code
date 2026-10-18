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

  it('says only "active" before any request, never "connected"', () => {
    const model = computeConnectionStatus({ name: 'Production', database: 'Contacts' });
    expect(model.text).toBe('$(circle-large-outline) FileMaker: Production');
    expect(model.tooltip).toContain('has not been checked');
    expect(model.tooltip).not.toContain('Connected to');
  });

  it('shows the real session health from the last request', () => {
    const profile = { name: 'Production', database: 'Contacts' };
    const at = 1;
    const connected = computeConnectionStatus(profile, { state: 'connected', at });
    expect(connected.text).toBe('$(plug) FileMaker: Production');
    expect(connected.tooltip).toContain('Connected to Production (Contacts)');
    expect(computeConnectionStatus(profile, { state: 'connecting', at }).text).toContain('$(sync~spin)');
    const auth = computeConnectionStatus(profile, { state: 'auth-failed', at, message: 'Invalid user account and/or password.' });
    expect(auth.text).toContain('sign-in failed');
    expect(auth.warning).toBe(true);
    expect(auth.tooltip).toContain('Invalid user account');
    const certificate = computeConnectionStatus(profile, { state: 'certificate', at, message: 'The certificate has expired.' });
    expect(certificate.text).toContain('certificate problem');
    expect(certificate.warning).toBe(true);
    const unreachable = computeConnectionStatus(profile, { state: 'unreachable', at, message: 'Nothing is listening.' });
    expect(unreachable.text).toContain('unreachable');
    expect(new Set([connected.text, auth.text, certificate.text, unreachable.text]).size).toBe(4);
  });

  it('keeps a persistent warning on a profile that skips all certificate checks, and not on a pinned one', () => {
    const legacy = computeConnectionStatus({ name: 'Old', database: 'D', allowSelfSigned: true }, { state: 'connected', at: 1 });
    expect(legacy.text).toContain('$(warning)');
    expect(legacy.tooltip).toContain('skips ALL certificate checks');
    expect(legacy.warning).toBe(true);
    const pinned = computeConnectionStatus({ name: 'New', database: 'D', allowSelfSigned: true, pinnedCertSha256: 'ab'.repeat(32) }, { state: 'connected', at: 1 });
    expect(pinned.text).not.toContain('$(warning)');
  });

  it('uses different icons for disconnected, active and connected so users can distinguish at a glance', () => {
    const disc = computeConnectionStatus(undefined);
    const idle = computeConnectionStatus({ name: 'Dev', database: 'D' });
    const conn = computeConnectionStatus({ name: 'Dev', database: 'D' }, { state: 'connected', at: 1 });
    expect(disc.text).toContain('$(circle-outline)');
    expect(conn.text).toContain('$(plug)');
    expect(new Set([disc.text, idle.text, conn.text]).size).toBe(3);
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
    expect(item.text).toBe('$(circle-large-outline) FileMaker: New');
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

describe('ConnectionStatusBar follows session health', () => {
  it('re-renders when the client reports a change, and stops listening when disposed', async () => {
    let health: { state: string; at: number; message?: string } | undefined;
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const bar = new ConnectionStatusBar(
      { getActiveProfileId: () => 'p1', getProfile: async () => ({ id: 'p1', name: 'Prod', database: 'D' }) } as never,
      {
        getHealth: () => health as never,
        onHealthChange: (callback: (...args: never[]) => void) => {
          listener = callback;
          return unsubscribe;
        }
      }
    );
    const item = vi.mocked(vscode.window.createStatusBarItem).mock.results.at(-1)?.value as vscode.StatusBarItem;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(item.text).toContain('circle-large-outline');

    health = { state: 'auth-failed', at: 1, message: 'Invalid account.' };
    listener?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(item.text).toContain('sign-in failed');

    bar.dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe('computeConnectionStatus version', () => {
  it('adds the extension version to the tooltip only', () => {
    const connected = computeConnectionStatus({ name: 'Dev', database: 'D' }, { state: 'connected', at: 1 }, '1.4.0');
    expect(connected.tooltip).toContain('FileMaker Data API Tools v1.4.0');
    expect(connected.text).not.toContain('1.4.0');
    expect(computeConnectionStatus(undefined, undefined, '1.4.0').tooltip).toContain('v1.4.0');
    expect(computeConnectionStatus(undefined).tooltip).not.toContain('FileMaker Data API Tools');
  });
});

describe('ConnectionStatusBar version wiring', () => {
  it('puts the version in the tooltip without a profile and with one, keeping the click command', async () => {
    const none = new ConnectionStatusBar({ getActiveProfileId: () => undefined, getProfile: vi.fn() } as never, undefined, '3.2.1');
    const noneItem = vi.mocked(vscode.window.createStatusBarItem).mock.results.at(-1)?.value as vscode.StatusBarItem;
    expect(noneItem.tooltip).toBe('No active FileMaker profile. Click for actions.\nFileMaker Data API Tools v3.2.1');
    expect(noneItem.command).toBe('filemakerDataApiTools.openConnectionMenu');
    none.dispose();

    const getProfile = vi.fn().mockResolvedValue({ id: 'p1', name: 'Prod', database: 'Sales' });
    const health = { getHealth: () => ({ state: 'connected', at: 1 }) as never, onHealthChange: () => () => undefined };
    const bar = new ConnectionStatusBar({ getActiveProfileId: () => 'p1', getProfile } as never, health, '3.2.1');
    const item = vi.mocked(vscode.window.createStatusBarItem).mock.results.at(-1)?.value as vscode.StatusBarItem;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(item.text).toBe('$(plug) FileMaker: Prod');
    expect(item.tooltip).toBe('Connected to Prod (Sales). Click for actions.\nFileMaker Data API Tools v3.2.1');
    bar.dispose();
  });
});
