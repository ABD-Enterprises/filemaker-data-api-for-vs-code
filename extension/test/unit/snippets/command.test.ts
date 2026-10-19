import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCopyRequestCommands } from '../../../src/commands/copyRequest';
import { generateSnippet } from '../../../src/snippets';
import { directProfile } from './fixtures';

const COMMAND = 'filemakerDataApiTools.copyRequestAsCode';
const profile = { ...directProfile, id: 'p1' };
const workspace = vscode.workspace as unknown as { isTrusted: boolean };

function setup(overrides: { listLayouts?: () => Promise<string[]> } = {}) {
  const fmClient = { listLayouts: vi.fn(overrides.listLayouts ?? (async () => ['Contacts', 'Orders'])) };
  const profileStore = {
    getProfile: vi.fn(async (id: string) => (id === profile.id ? profile : undefined)),
    listProfiles: vi.fn(async () => [profile]),
    getActiveProfileId: vi.fn(() => profile.id)
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  vi.mocked(vscode.commands.registerCommand).mockClear();
  registerCopyRequestCommands({ profileStore: profileStore as never, fmClient: fmClient as never, logger: logger as never });
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === COMMAND);
  if (!call) {
    throw new Error('command not registered');
  }
  return { run: call[1] as (arg?: unknown) => Promise<unknown>, fmClient, profileStore };
}

const clipboard = (): unknown[] => vi.mocked(vscode.env.clipboard.writeText).mock.calls.map((c) => c[0]);

describe('FileMaker: Copy Request as Code…', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workspace.isTrusted = true;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback } as never);
    vi.mocked(vscode.window.withProgress).mockImplementation(((_o: unknown, task: () => unknown) => task()) as never);
  });

  it('is registered under the id the manifest declares', () => {
    setup();
    expect(vi.mocked(vscode.commands.registerCommand).mock.calls.map(([id]) => id)).toContain(COMMAND);
  });

  it('given a profile, an operation and a format it asks nothing and copies', async () => {
    const { run } = setup();
    const operation = { kind: 'getRecord', layout: 'Orders/2026', recordId: '5' } as const;
    await run({ profileId: 'p1', operation, format: 'http' });
    expect(clipboard()).toEqual([generateSnippet(profile, operation, 'http')]);
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it('opens an unsaved editor when asked, and never writes a file', async () => {
    const { run } = setup();
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);
    await run({ profileId: 'p1', operation: { kind: 'listLayouts' }, format: 'http', destination: 'editor' });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ language: 'http' }));
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(clipboard()).toEqual([]);
  });

  it('refuses an operation argument that is not valid, and copies nothing', async () => {
    const { run } = setup();
    await run({ profileId: 'p1', operation: { kind: 'getRecord', layout: 'L' }, format: 'curl' });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('not valid'));
    expect(clipboard()).toEqual([]);
  });

  it('asks for the operation, the layout, the details and the format, in that order', async () => {
    const { run, fmClient } = setup();
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: 'Edit a record', operation: 'editRecord' } as never)
      .mockResolvedValueOnce('Orders' as never)
      .mockResolvedValueOnce({ label: 'curl', id: 'curl' } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(' 42 ').mockResolvedValueOnce('{"Status": "Shipped"}');
    await run();
    expect(fmClient.listLayouts).toHaveBeenCalledTimes(1);
    expect(clipboard()).toEqual([
      generateSnippet(profile, { kind: 'editRecord', layout: 'Orders', recordId: '42', fieldData: { Status: 'Shipped' } }, 'curl')
    ]);
    const titles = vi.mocked(vscode.window.showQuickPick).mock.calls.map((c) => (c[1] as { title: string }).title);
    expect(titles[0]).toContain('which request');
    expect(titles[1]).toContain('Select Layout');
    expect(titles[2]).toContain('which format');
  });

  it('a find takes the criteria as a JSON list; a script takes name, parameter and record', async () => {
    const { run } = setup();
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ operation: 'find' } as never)
      .mockResolvedValueOnce('Contacts' as never)
      .mockResolvedValueOnce({ id: 'postman' } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('[{"City": "Portland"}]');
    await run();
    expect(String(clipboard()[0])).toContain('\\"City\\": \\"Portland\\"');

    vi.mocked(vscode.env.clipboard.writeText).mockClear();
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ operation: 'runScript' } as never)
      .mockResolvedValueOnce('Contacts' as never)
      .mockResolvedValueOnce({ id: 'curl' } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(' Send Welcome ').mockResolvedValueOnce('hi there').mockResolvedValueOnce('7');
    await run();
    expect(clipboard()).toEqual([
      generateSnippet(profile, { kind: 'runScript', layout: 'Contacts', scriptName: 'Send Welcome', scriptParam: 'hi there', recordId: '7' }, 'curl')
    ]);
  });

  it('the editor choice in the format list opens the request as .http in a new editor', async () => {
    const { run } = setup();
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ operation: 'login' } as never).mockResolvedValueOnce({ id: 'editor' } as never);
    await run();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ language: 'http', content: generateSnippet(profile, { kind: 'login' }, 'http') });
    expect(clipboard()).toEqual([]);
  });

  it.each([
    ['the operation', []],
    ['the layout', [{ operation: 'getRecord' }]],
    ['the record id', [{ operation: 'getRecord' }, 'Contacts']],
    ['the format', [{ operation: 'listLayouts' }]]
  ])('copies nothing when the user cancels at %s', async (_step, picks) => {
    const { run } = setup();
    for (const pick of picks) {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(pick as never);
    }
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined as never);
    await run();
    expect(clipboard()).toEqual([]);
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('reports a layout list that cannot be loaded, without copying', async () => {
    const { run } = setup({ listLayouts: async () => Promise.reject(new Error('offline')) });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ operation: 'getRecord' } as never);
    await run();
    expect(clipboard()).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('works in an untrusted workspace (it only builds text) and follows the include-auth setting', async () => {
    const { run } = setup();
    workspace.isTrusted = false;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => true } as never);
    await run({ profileId: 'p1', operation: { kind: 'listScripts' }, format: 'curl' });
    expect(clipboard()).toHaveLength(1);
    expect(String(clipboard()[0])).toContain('"Authorization: Bearer $FM_TOKEN"');
  });
});
