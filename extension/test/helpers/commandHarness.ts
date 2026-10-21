import { expect, vi } from 'vitest';
import * as vscode from 'vscode';

import type { ConnectionProfile } from '../../src/types/fm';

export const profile: ConnectionProfile = {
  id: 'p1',
  name: 'Development',
  database: 'Contacts',
  serverUrl: 'https://example.invalid',
  authMode: 'direct',
  username: 'tester'
};

export const layout = ' Sales / 2026 ';

export function resetCommandMocks(): void {
  vi.clearAllMocks();
  for (const mock of [
    vscode.window.showQuickPick,
    vscode.window.showInputBox,
    vscode.window.showOpenDialog,
    vscode.window.showSaveDialog,
    vscode.window.showInformationMessage,
    vscode.window.showWarningMessage,
    vscode.window.showErrorMessage,
    vscode.workspace.openTextDocument,
    vscode.workspace.fs.readFile,
    vscode.workspace.fs.writeFile,
    vscode.workspace.fs.createDirectory
  ]) {
    vi.mocked(mock).mockReset();
  }
  vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
  vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);
  vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined);
  vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);
  vi.mocked(vscode.window.withProgress).mockImplementation(((_options: unknown, task: () => unknown) => task()) as never);
  const workspace = vscode.workspace as unknown as { isTrusted: boolean; workspaceFolders: unknown };
  workspace.isTrusted = true;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file('/tmp/workspace') }];
}

export function command(name: string): (...args: unknown[]) => unknown {
  const registered = vi.mocked(vscode.commands.registerCommand).mock.calls.find(
    ([id]) => id === `filemakerDataApiTools.${name}`
  );
  if (!registered) throw new Error(`Command ${name} was not registered`);
  return registered[1];
}

export function profileStore() {
  return {
    getProfile: vi.fn().mockResolvedValue(profile),
    listProfiles: vi.fn().mockResolvedValue([profile]),
    getActiveProfileId: vi.fn().mockReturnValue(profile.id)
  };
}

export function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

export function expectSafeError(): void {
  expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
  const message = vi.mocked(vscode.window.showErrorMessage).mock.calls[0]![0];
  expect(message).toMatch(/failed/i);
  expect(message).not.toContain('command-secret');
}

// Match an HTTP failure: credentials belong to request details, never the toast.
export const serviceError = () => Object.assign(
  new Error('Operation failed: Authorization: Bearer command-secret'),
  { isAxiosError: true, response: { status: 500, data: {}, headers: {} },
    config: { headers: { Authorization: 'Bearer command-secret' } } }
);
