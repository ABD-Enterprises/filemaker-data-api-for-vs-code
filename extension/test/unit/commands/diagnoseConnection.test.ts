import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerConnectionDiagnosticCommands } from '../../../src/commands/diagnoseConnection';
import * as diagnostics from '../../../src/services/connectionDiagnostics';
import * as tlsAgent from '../../../src/services/tlsAgent';
import type { ConnectionProfile } from '../../../src/types/fm';

const profile: ConnectionProfile = { id: 'p', name: 'Office', serverUrl: 'https://fm.example.test', database: 'DB', authMode: 'direct' };
function setup(profiles = [profile], active: string | undefined = 'p') {
  const deps = { profileStore: { listProfiles: vi.fn().mockResolvedValue(profiles), getActiveProfileId: () => active }, fmClient: {}, roleGuard: { isOfflineModeEnabled: vi.fn().mockReturnValue(false) } };
  registerConnectionDiagnosticCommands(deps as never);
  const handler = (suffix: string) => vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === `filemakerDataApiTools.${suffix}`)![1] as (arg?: unknown) => Promise<void>;
  return { deps, run: handler('diagnoseConnection'), copy: handler('copyConnectionDiagnosis') };
}
const workspace = vscode.workspace as unknown as { isTrusted: boolean };
let signal: AbortSignal;

beforeEach(() => {
  vi.clearAllMocks(); workspace.isTrusted = true;
  vi.spyOn(diagnostics, 'runConnectionDiagnostics').mockImplementation(async (_p, _settings, _probes, s) => { signal = s; return { address: profile.serverUrl, steps: [] }; });
  vi.mocked(vscode.window.withProgress).mockImplementation(async (_options, task) => task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: vi.fn() }) }));
  vi.mocked(vscode.window.showQuickPick).mockResolvedValue('Diagnose active profile' as never);
});
afterEach(() => { vi.restoreAllMocks(); workspace.isTrusted = true; });

describe('Diagnose Connection command', () => {
  it('diagnoses the active saved profile without sign-in, and opens an untitled Markdown document', async () => {
    const policy = vi.spyOn(tlsAgent, 'setSystemCertificatePolicy');
    const { run } = setup(); await run();
    expect(policy).toHaveBeenCalledWith(expect.any(Function));
    expect(policy.mock.calls[0]![0]()).toBe(true);
    expect(diagnostics.runConnectionDiagnostics).toHaveBeenCalledWith(profile, expect.objectContaining({ proxySupport: 'override' }), expect.any(Object), expect.any(AbortSignal));
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ language: 'markdown', content: expect.stringContaining('Most likely cause') });
    expect(vscode.window.showTextDocument).toHaveBeenCalled(); expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    expect(vscode.window.withProgress).toHaveBeenCalledWith(expect.objectContaining({ cancellable: true }), expect.any(Function));
  });
  it('offers a profile picker when none is active and resolves a profileId argument', async () => {
    const { run } = setup([profile, { ...profile, id: 'p2' }], undefined);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Office', profile } as never);
    await run();
    expect(diagnostics.runConnectionDiagnostics).toHaveBeenCalledWith(profile, expect.any(Object), expect.any(Object), expect.any(AbortSignal));
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue('Diagnose active profile' as never);
    await run({ profileId: 'p2' });
    expect(diagnostics.runConnectionDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'p2' }), expect.any(Object), expect.any(Object), expect.any(AbortSignal));
  });
  it('allows a typed check with no saved profiles, without reading or saving secrets', async () => {
    const { run } = setup([], undefined);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: 'Type a server address (without saving)' } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('https://quick.example.test:8443');
    await run();
    expect(diagnostics.runConnectionDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://quick.example.test:8443', database: '', authMode: 'direct' }), expect.any(Object), expect.any(Object), expect.any(AbortSignal));
  });
  it('can switch from an active profile to a typed address', async () => {
    const { run } = setup();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce('Choose another profile or type an address' as never).mockResolvedValueOnce({ label: 'Type a server address (without saving)' } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('https://quick.example.test'); await run();
    expect(diagnostics.runConnectionDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://quick.example.test' }), expect.any(Object), expect.any(Object), expect.any(AbortSignal));
  });
  it('refuses offline mode before selecting an address or probing', async () => {
    const { run, deps } = setup(); deps.roleGuard.isOfflineModeEnabled.mockReturnValue(true); await run();
    expect(deps.profileStore.listProfiles).not.toHaveBeenCalled(); expect(diagnostics.runConnectionDiagnostics).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Offline mode'));
  });
  it('rechecks offline mode after dialogs', async () => {
    const { run, deps } = setup(); deps.roleGuard.isOfflineModeEnabled.mockReturnValueOnce(false).mockReturnValue(true); await run();
    expect(diagnostics.runConnectionDiagnostics).not.toHaveBeenCalled();
  });
  it('refuses an untrusted template address with existing wording, but permits a user profile', async () => {
    const { run } = setup([{ ...profile, serverUrlSource: 'workspace-template' }]); workspace.isTrusted = false; await run();
    expect(diagnostics.runConnectionDiagnostics).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('.filemaker/profile-template.json was ignored because this workspace is not trusted. Trust the workspace to use it, or enter the details manually.');
  });
  it('permits user-owned profiles in Restricted Mode', async () => {
    const { run } = setup(); workspace.isTrusted = false; await run(); expect(diagnostics.runConnectionDiagnostics).toHaveBeenCalled();
  });
  it('cancels probes through withProgress and disposes the cancellation listener', async () => {
    const dispose = vi.fn();
    let cancel: () => void = () => undefined;
    vi.mocked(vscode.window.withProgress).mockImplementation(async (_options, task) => {
      const result = task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: (callback) => { cancel = () => callback(undefined); return { dispose }; } });
      cancel(); return result;
    });
    const { run } = setup(); await run(); expect(signal.aborted).toBe(true); expect(dispose).toHaveBeenCalledOnce();
  });
  it('stops when the picker or typed address is dismissed', async () => {
    const { run } = setup(); vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined); await run();
    expect(diagnostics.runConnectionDiagnostics).not.toHaveBeenCalled();
  });
  it('copies with optional masking, and does nothing if the copy prompt is cancelled', async () => {
    const { run, copy } = setup(); await run();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue('Yes, hide it' as never); await copy();
    expect(vscode.window.showQuickPick).toHaveBeenLastCalledWith(['Yes, hide it', 'No, include it'], { title: 'Hide the server address?' });
    expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith(expect.not.stringContaining('fm.example.test'));
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue('No, include it' as never); await copy();
    expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('fm.example.test'));
    vi.mocked(vscode.env.clipboard.writeText).mockClear(); vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined); await copy();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });
  it('explains that a report is needed before copying', async () => {
    const { copy } = setup(); await copy(); expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('first'));
  });
  it('handles errors without including raw profile or server secrets', async () => {
    const { run } = setup(); vi.mocked(diagnostics.runConnectionDiagnostics).mockRejectedValue(new Error('password-secret')); await run();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.not.stringContaining('password-secret'));
  });
});
