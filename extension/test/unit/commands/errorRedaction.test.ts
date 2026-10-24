import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerAiMcpCommands } from '../../../src/commands/aiMcp';
import { registerShowDiagnosticsCommand } from '../../../src/commands/showDiagnostics';
import { command, resetCommandMocks } from '../../helpers/commandHarness';

describe('command error toast redaction', () => {
  beforeEach(resetCommandMocks);

  it('redacts AI server failures', async () => {
    registerAiMcpCommands({
      controller: { isRunning: () => true, stopHere: vi.fn().mockRejectedValue(new Error('Stop failed: Bearer command-secret')) } as never,
      extensionPath: '/tmp/extension', globalStoragePath: undefined,
      isEnabled: () => true, refresh: vi.fn()
    });
    await command('toggleAiServer')();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Stop failed: Bearer ***');
  });

  it('redacts diagnostic report failures', async () => {
    const context = { get extension() { throw new Error('Report failed: Basic command-secret'); } };
    registerShowDiagnosticsCommand(context as never);
    await command('showDiagnostics')();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to build diagnostic report: Report failed: Basic ***');
  });
});
