import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { aboutFactsMarkdown, activationLogLine, collectAboutInputs, registerAboutCommand } from '../../src/about/aboutCommand';
import { buildDiagnosticReport } from '../../src/commands/showDiagnostics';

const makeContext = (overrides: Record<string, unknown> = {}) =>
  ({
    extensionUri: vscode.Uri.file('/ext'),
    extensionMode: 1,
    extension: { id: 'x.y', packageJSON: { version: '2.3.4' } },
    globalState: { get: vi.fn(() => []) },
    workspaceState: { get: vi.fn() },
    ...overrides
  }) as unknown as vscode.ExtensionContext;

const env = vscode.env as unknown as Record<string, unknown>;

function handler(): () => Promise<void> {
  vi.mocked(vscode.commands.registerCommand).mockClear();
  registerAboutCommand(makeContext());
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'filemakerDataApiTools.about');
  expect(call).toBeDefined();
  return call?.[1] as () => Promise<void>;
}

describe('About / Show Version command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.remoteName = undefined;
  });

  it('shows the version, build and VS Code version in the message with three buttons', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
    await handler()();
    const [message, ...buttons] = vi.mocked(vscode.window.showInformationMessage).mock.calls[0] as string[];
    expect(message).toContain('FileMaker Data API Tools 2.3.4');
    expect(message).toContain('Build unknown (unknown)');
    expect(message).toContain('VS Code 1.96.0');
    expect(buttons).toEqual(['Copy for bug report', 'Open Changelog', 'Report an Issue']);
  });

  it('does nothing when the message is dismissed', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
    await handler()();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledTimes(1);
  });

  it('Copy for bug report writes the Markdown block to the clipboard', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Copy for bug report' as never);
    await handler()();
    const text = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0]?.[0] as string;
    expect(text).toContain('**FileMaker Data API Tools: version details**');
    expect(text).toContain('- **Extension:** FileMaker Data API Tools 2.3.4');
    expect(text).toBe(aboutFactsMarkdown(makeContext()).markdown);
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it('Open Changelog previews the CHANGELOG.md shipped in the extension', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Open Changelog' as never);
    await handler()();
    expect(vscode.Uri.joinPath).toHaveBeenCalledWith(expect.anything(), 'CHANGELOG.md');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('markdown.showPreview', expect.objectContaining({ fsPath: 'CHANGELOG.md' }));
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it('Open Changelog falls back to the GitHub releases page when the preview fails', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Open Changelog' as never);
    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('no preview'));
    await handler()();
    expect(vscode.Uri.parse).toHaveBeenCalledWith('https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases');
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
  });

  it('Report an Issue opens the https new-issue URL with the version fields', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Report an Issue' as never);
    await handler()();
    const url = vi.mocked(vscode.Uri.parse).mock.calls.at(-1)?.[0] as string;
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.pathname).toBe('/SureForgeTech/filemaker-data-api-for-vs-code/issues/new');
    expect(parsed.searchParams.get('extension-version')).toBe('2.3.4');
    expect(parsed.searchParams.get('version-details')).toContain('version details');
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
  });
});

describe('collectAboutInputs', () => {
  const versions = process.versions;
  beforeEach(() => {
    env.remoteName = undefined;
  });

  it('reads Node and Electron from the extension host, the remote name and trust from VS Code', () => {
    Object.defineProperty(process, 'versions', {
      value: { ...versions, node: '20.1.2', electron: '32.0.1' },
      configurable: true
    });
    env.remoteName = 'wsl';
    try {
      const inputs = collectAboutInputs(makeContext());
      expect(inputs).toMatchObject({
        extensionVersion: '2.3.4',
        nodeVersion: '20.1.2',
        electronVersion: '32.0.1',
        remoteName: 'wsl',
        vscodeVersion: '1.96.0',
        appName: 'Visual Studio Code',
        language: 'en',
        platform: process.platform,
        arch: process.arch,
        workspaceTrusted: true,
        installKind: 'installed'
      });
    } finally {
      Object.defineProperty(process, 'versions', { value: versions, configurable: true });
    }
  });

  it('maps the extension mode to the install kind and has no Electron when the host is plain Node', () => {
    expect(collectAboutInputs(makeContext({ extensionMode: 2 })).installKind).toBe('development host');
    expect(collectAboutInputs(makeContext({ extensionMode: 3 })).installKind).toBe('test host');
    Object.defineProperty(process, 'versions', {
      value: { ...versions, electron: undefined },
      configurable: true
    });
    try {
      expect(collectAboutInputs(makeContext()).electronVersion).toBeUndefined();
      expect(aboutFactsMarkdown(makeContext()).markdown).toContain('Electron unknown');
    } finally {
      Object.defineProperty(process, 'versions', { value: versions, configurable: true });
    }
  });

  it('reads the AI switch and enterprise mode from the settings', () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: (key: string, fallback: unknown) => (key === 'enterprise.mode' ? true : key === 'features.ai.enabled' ? false : fallback)
    } as never);
    expect(collectAboutInputs(makeContext())).toMatchObject({ aiEnabled: false, enterpriseMode: true });
  });

  it('builds the activation line from the live values', () => {
    expect(activationLogLine(makeContext())).toBe(`FileMaker Data API Tools v2.3.4 (unknown) on VS Code 1.96.0, ${process.platform}-${process.arch}`);
  });
});

describe('Show Diagnostics version block', () => {
  it('includes the same facts block', async () => {
    const report = await buildDiagnosticReport(makeContext());
    expect(report).toContain('## Version details');
    expect(report).toContain('- **Extension:** FileMaker Data API Tools 2.3.4');
  });

  it('still produces a report when the version facts cannot be read', async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const report = await buildDiagnosticReport(makeContext());
    expect(report).toContain('_Version details are unavailable._');
    expect(report).toContain('## Settings');
  });
});
