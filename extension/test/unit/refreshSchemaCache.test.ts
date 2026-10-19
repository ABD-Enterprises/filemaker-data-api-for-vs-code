import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerSchemaCommands } from '../../src/commands/schema';

describe('Refresh Schema Cache', () => {
  beforeEach(() => vi.clearAllMocks());

  function run(listProfiles: () => Promise<Array<{ id: string }>>) {
    const schemaService = { invalidateAll: vi.fn() };
    const fmClient = { invalidateProfileCache: vi.fn() };
    const refreshExplorer = vi.fn();
    const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    registerSchemaCommands({ profileStore: { listProfiles } as never, fmClient: fmClient as never, schemaService: schemaService as never, logger: logger as never, refreshExplorer });
    const callback = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'filemakerDataApiTools.refreshSchemaCache')?.[1] as () => Promise<void>;
    return { callback, schemaService, fmClient, refreshExplorer, logger };
  }

  it('clears the schema cache AND the client caches (layout list, metadata) of every profile, then refreshes the Explorer', async () => {
    const { callback, schemaService, fmClient, refreshExplorer } = run(async () => [{ id: 'a' }, { id: 'b' }]);
    await callback();
    expect(schemaService.invalidateAll).toHaveBeenCalledTimes(1);
    expect(fmClient.invalidateProfileCache.mock.calls).toEqual([['a'], ['b']]);
    expect(refreshExplorer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(vscode.window.showInformationMessage).mock.calls[0]?.[0]).toMatch(/layouts will be read again/);
  });

  it('still refreshes the Explorer when the profiles cannot be listed', async () => {
    const { callback, refreshExplorer, logger } = run(async () => {
      throw new Error('storage');
    });
    await callback();
    expect(logger.warn).toHaveBeenCalled();
    expect(refreshExplorer).toHaveBeenCalledTimes(1);
  });
});
