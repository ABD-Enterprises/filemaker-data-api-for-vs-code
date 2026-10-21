import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerTestMyServerCommand, SELF_TEST_NOTICE } from '../../src/commands/testMyServer';
import type * as SelfTestModule from '../../src/services/serverSelfTest';
import { testMyServer, type SelfTestUi, type SelfTestReport } from '../../src/services/serverSelfTest';
import { createSelfTestClient } from '../../src/services/serverSelfTestClient';
import { InMemoryMemento } from './mocks';

vi.mock('../../src/services/serverSelfTestClient', () => ({ createSelfTestClient: vi.fn(async () => ({ scrub: (text: string) => text })) }));
vi.mock('../../src/services/serverSelfTest', async (original) => ({ ...await original<typeof SelfTestModule>(), testMyServer: vi.fn() }));

function harness(options: { trusted?: boolean; offline?: boolean; enabled?: boolean; role?: boolean; profile?: boolean } = {}) {
  Object.defineProperty(vscode.workspace, 'isTrusted', { value: options.trusted ?? true, configurable: true });
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => key === 'offline.mode' ? options.offline ?? false : key.startsWith('features.') ? options.enabled ?? true : fallback } as never);
  const workspaceState = new InMemoryMemento();
  const deps = {
    context: { workspaceState },
    profileStore: { getActiveProfileId: () => options.profile === false ? undefined : 'p', getProfile: async () => ({ id: 'p', name: 'P', serverUrl: 'https://server.example', database: 'Test', username: 'u', authMode: 'direct' }) },
    secretStore: {}, settingsService: { getRequestTimeoutMs: () => 1234 },
    roleGuard: { getFeatureGuard: () => ({ allowed: options.role ?? true }) }, logger: {}
  };
  registerTestMyServerCommand(deps as never);
  const entry = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'filemakerDataApiTools.testMyServer')!;
  const run = entry[1] as () => Promise<void>;
  return { run, workspaceState };
}
function serviceUi() {
  return vi.mocked(testMyServer).mock.calls.at(-1)![2] as SelfTestUi;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(testMyServer).mockResolvedValue(undefined);
  vi.mocked(vscode.window.withProgress).mockImplementation(async (_options, task) => task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: vi.fn() }) }));
});

describe('Test My Server command wiring and choices', () => {
  it('registers, uses configured timeout, and offers an explicit modal with the full plan', async () => {
    const h = harness(); await h.run();
    expect(createSelfTestClient).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), expect.anything(), expect.anything(), 1234);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Run read-only test' as never);
    expect(await serviceUi().start()).toBe('read');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(SELF_TEST_NOTICE, { modal: true }, 'Run read-only test', 'Also run the write test');
    expect(SELF_TEST_NOTICE).toContain('first 3 layouts');
    expect(SELF_TEST_NOTICE).toContain('never prints passwords or tokens');
  });

  it.each([{ trusted: false }, { enabled: false }, { role: false }])('blocks writes and scripts under restrictions: %j', async (options) => {
    const h = harness(options); await h.run();
    const ui = serviceUi();
    expect(ui.allowed('read')).toBe(true);
    expect(ui.allowed('write')).toBe(false);
    expect(ui.allowed('script')).toBe(false);
    await ui.start();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(SELF_TEST_NOTICE, { modal: true }, 'Run read-only test');
  });

  it.each([{ offline: true }, { profile: false }])('does not construct a client or make requests when unavailable: %j', async (options) => {
    const h = harness(options); await h.run();
    expect(createSelfTestClient).not.toHaveBeenCalled();
    expect(testMyServer).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  it('preserves names, remembers the read layout per profile, and names the scratch layout in the second modal', async () => {
    const h = harness(); await h.run();
    const ui = serviceUi();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: ' Layout ' } as never);
    expect(await ui.pickLayout(['Other', ' Layout '], false)).toBe(' Layout ');
    expect(h.workspaceState.get('filemakerDataApiTools.selfTest.layout.p')).toBe(' Layout ');
    await ui.pickLayout(['Other', ' Layout '], false);
    expect(vi.mocked(vscode.window.showQuickPick).mock.calls.at(-1)![0]).toMatchObject([{ label: ' Layout ', description: 'Last choice' }, { label: 'Other' }]);
    await ui.confirmWrite(' Scratch ');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('SCRATCH layout " Scratch ": one test record will be created, read, edited and deleted.'), { modal: true }, 'Create, edit and delete one test record');
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(' Script ').mockResolvedValueOnce(' Parameter ');
    expect(await ui.script()).toEqual({ name: ' Script ', parameter: ' Parameter ' });
  });

  it('opens an untitled markdown document and copies a masked, redacted report', async () => {
    const h = harness();
    const report: SelfTestReport = { server: 'https://server.example', steps: [], facts: ['HTTP 500, code 401'], problems: [] };
    vi.mocked(testMyServer).mockResolvedValue(report);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Copy report with server address hidden' as never);
    await h.run();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ language: 'markdown', content: expect.stringContaining('https://server.example') });
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expect.not.stringContaining('server.example'));
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('HTTP 500, code 401'));
  });

  it('does not include raw exceptions in error messages', async () => {
    const h = harness(); vi.mocked(testMyServer).mockRejectedValue(new Error('password=secret'));
    await h.run();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Test My Server could not finish. Check the active connection and try again.');
  });
});
