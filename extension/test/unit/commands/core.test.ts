import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

import {
  parseProfileId,
  parseLayoutArg,
  parseRecordArg,
  formatError
} from '../../../src/commands/common';
import { registerCoreCommands } from '../../../src/commands/index';

describe('parseProfileId', () => {
  it('returns profileId from valid arg', () => {
    expect(parseProfileId({ profileId: 'p1' })).toBe('p1');
  });

  it('returns undefined for null arg', () => {
    expect(parseProfileId(null)).toBeUndefined();
  });

  it('returns undefined for non-object arg', () => {
    expect(parseProfileId('string')).toBeUndefined();
  });

  it('returns undefined when profileId is not a string', () => {
    expect(parseProfileId({ profileId: 42 })).toBeUndefined();
  });
});

describe('parseLayoutArg', () => {
  it('extracts layout from arg with layout field', () => {
    const result = parseLayoutArg({ profileId: 'p1', layout: 'Contacts' });
    expect(result).toEqual({ profileId: 'p1', layout: 'Contacts' });
  });

  it('extracts layout from arg with layoutName field', () => {
    const result = parseLayoutArg({ layoutName: 'Invoices' });
    expect(result).toEqual({ profileId: undefined, layout: 'Invoices' });
  });

  it('prefers layout over layoutName', () => {
    const result = parseLayoutArg({ layout: 'A', layoutName: 'B' });
    expect(result.layout).toBe('A');
  });

  it('returns empty object for null arg', () => {
    expect(parseLayoutArg(null)).toEqual({});
  });
});

describe('parseRecordArg', () => {
  it('extracts profile, layout, and recordId from explorer args', () => {
    expect(parseRecordArg({ profileId: 'p1', layoutName: 'Contacts', recordId: 42 })).toEqual({
      profileId: 'p1',
      layout: 'Contacts',
      recordId: '42'
    });
  });

  it('extracts recordId from nested record payloads', () => {
    expect(parseRecordArg({ layout: 'Invoices', record: { recordId: '  99  ' } })).toEqual({
      profileId: undefined,
      layout: 'Invoices',
      recordId: '99'
    });
  });
});

describe('formatError', () => {
  it('extracts message from Error', () => {
    expect(formatError(new Error('boom'))).toContain('boom');
  });

  it('handles non-Error input', () => {
    expect(formatError('text')).toBeTruthy();
  });
});

describe('registerCoreCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMockDeps() {
    return {
      context: {
        subscriptions: [],
        extensionUri: { fsPath: '/ext' }
      } as unknown as vscode.ExtensionContext,
      profileStore: {
        upsertProfile: vi.fn(),
        removeProfile: vi.fn(),
        getProfile: vi.fn(),
        listProfiles: vi.fn().mockResolvedValue([]),
        getActiveProfileId: vi.fn().mockReturnValue(undefined),
        setActiveProfileId: vi.fn()
      } as never,
      secretStore: {
        setPassword: vi.fn(),
        deletePassword: vi.fn(),
        setProxyApiKey: vi.fn(),
        deleteProxyApiKey: vi.fn(),
        clearProfileSecrets: vi.fn(),
        getPassword: vi.fn(),
        getProxyApiKey: vi.fn()
      } as never,
      savedQueriesStore: {
        removeQueriesForProfile: vi.fn()
      } as never,
      fmClient: {
        createSession: vi.fn(),
        deleteSession: vi.fn(),
        invalidateProfileCache: vi.fn(),
        listLayouts: vi.fn().mockResolvedValue([])
      } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never,
      roleGuard: {
        assertFeature: vi.fn().mockResolvedValue(true),
        isProfileLocked: vi.fn().mockReturnValue(false)
      } as never,
      refreshExplorer: vi.fn(),
      onProfileDisconnected: vi.fn(),
      getWebDirectBasePath: vi.fn(() => '/fmi/webd')
    };
  }

  it('registers multiple command disposables', () => {
    const deps = createMockDeps();
    const disposables = registerCoreCommands(deps);

    expect(disposables.length).toBeGreaterThan(0);
    expect(vi.mocked(vscode.commands.registerCommand)).toHaveBeenCalled();
  });

  it('registers the connect command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi.mocked(vscode.commands.registerCommand).mock.calls.map(
      ([name]) => name
    );
    expect(registeredNames).toContain('filemakerDataApiTools.connect');
  });

  it('registers the disconnect command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi.mocked(vscode.commands.registerCommand).mock.calls.map(
      ([name]) => name
    );
    expect(registeredNames).toContain('filemakerDataApiTools.disconnect');
  });

  it('registers the addConnectionProfile command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi.mocked(vscode.commands.registerCommand).mock.calls.map(
      ([name]) => name
    );
    expect(registeredNames).toContain('filemakerDataApiTools.addConnectionProfile');
  });

  it('registers the removeConnectionProfile command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi.mocked(vscode.commands.registerCommand).mock.calls.map(
      ([name]) => name
    );
    expect(registeredNames).toContain('filemakerDataApiTools.removeConnectionProfile');
  });

  it('registers the editConnectionProfile command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi.mocked(vscode.commands.registerCommand).mock.calls.map(
      ([name]) => name
    );
    expect(registeredNames).toContain('filemakerDataApiTools.editConnectionProfile');
  });

  it('registers the WebDirect URL command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi.mocked(vscode.commands.registerCommand).mock.calls.map(
      ([name]) => name
    );
    expect(registeredNames).toContain('filemakerDataApiTools.copyWebDirectUrlForCurrentRecord');
  });

  it('copies and optionally opens the WebDirect URL for a selected record', async () => {
    const deps = createMockDeps();
    (deps.profileStore as { getProfile: ReturnType<typeof vi.fn> }).getProfile = vi
      .fn()
      .mockResolvedValue({
        id: 'p1',
        name: 'Dev',
        serverUrl: 'https://fm.example.com',
        database: 'Contacts DB',
        authMode: 'direct'
      });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Open in Browser' as never
    );
    registerCoreCommands(deps);

    const call = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(
        ([name]) => name === 'filemakerDataApiTools.copyWebDirectUrlForCurrentRecord'
      );
    const handler = call?.[1] as ((arg: unknown) => Promise<void>) | undefined;
    expect(handler).toBeDefined();

    await handler?.({ profileId: 'p1', layoutName: 'Customer Detail', recordId: '42' });

    const expectedUrl =
      'https://fm.example.com/fmi/webd/db/Contacts%20DB/Customer%20Detail#recordid=42';
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expectedUrl);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      `WebDirect URL copied: ${expectedUrl}`,
      'Open in Browser'
    );
    expect(vscode.Uri.parse).toHaveBeenCalledWith(expectedUrl);
    expect(vscode.env.openExternal).toHaveBeenCalled();
  });
});
