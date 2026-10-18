import { join } from 'path';

import * as vscode from 'vscode';

import type { AiMcpController } from '../ai/mcp/aiMcpController';
import { buildMcpConfig, discoveryDirectory } from '../ai/mcp/mcpConfig';

export const TOGGLE_SERVER_COMMAND = 'filemakerDataApiTools.toggleAiServer';
export const COPY_MCP_CONFIG_COMMAND = 'filemakerDataApiTools.copyAiMcpConfig';

interface Deps {
  controller: AiMcpController;
  extensionPath: string;
  globalStoragePath: string;
  isEnabled: () => boolean;
  refresh: () => void;
}

export function registerAiMcpCommands(deps: Deps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(TOGGLE_SERVER_COMMAND, async () => {
      try {
        if (deps.controller.isRunning()) {
          await deps.controller.stop();
          void vscode.window.showInformationMessage('The AI server for external tools is stopped.');
        } else {
          if (!deps.isEnabled()) {
            // Only you can allow this: a modal, then your user settings.
            const choice = await vscode.window.showWarningMessage(
              'Allow external AI tools (such as Claude Code or Cursor) to use FileMaker through this window?',
              {
                modal: true,
                detail:
                  'This starts a local server that programs running as you can connect to with a secret token. Everything the AI tools can do is limited by your AI settings, layout approvals and write dialogs, and what they read goes to the model provider you use. This turns on filemaker.ai.externalServer.enabled in your user settings.'
              },
              'Turn On and Start'
            );
            if (choice !== 'Turn On and Start') {
              return;
            }
            await vscode.workspace
              .getConfiguration('filemaker')
              .update('ai.externalServer.enabled', true, vscode.ConfigurationTarget.Global);
          }
          await deps.controller.start();
          void vscode.window.showInformationMessage(
            'The AI server for external tools is running. Use "FileMaker: Copy MCP Config for Claude Code / Cursor" to connect a client.'
          );
        }
      } catch (error) {
        void vscode.window.showErrorMessage((error as Error).message);
      }
      deps.refresh();
    }),

    vscode.commands.registerCommand(COPY_MCP_CONFIG_COMMAND, async () => {
      const config = buildMcpConfig({
        shimPath: join(deps.extensionPath, 'dist', 'aiMcpShim.js'),
        discoveryDir: discoveryDirectory(deps.globalStoragePath),
        workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      });
      await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
      void vscode.window.showInformationMessage(
        'MCP config copied. Paste it into your Claude Code .mcp.json (or run "claude mcp add-json filemaker" with the filemaker entry) or Cursor mcp.json. It needs Node.js 18 or newer on your PATH. The server must be running in this window, and what the tools read goes to your AI model provider.'
      );
    })
  ];
}
