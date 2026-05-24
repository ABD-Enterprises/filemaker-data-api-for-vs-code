import * as vscode from 'vscode';
import { dirname, join } from 'path';

import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SettingsService } from '../services/settingsService';
import type { TypeGenService } from '../services/typeGenService';
import { localize } from '../i18n';
import { parseLayoutArg, promptForLayout, resolveProfileFromArg, showCommandError } from './common';

interface RegisterTypeGenCommandsDeps {
  profileStore: ProfileStore;
  fmClient: FMClient;
  typeGenService: TypeGenService;
  settingsService: SettingsService;
  logger: Logger;
}

export function registerTypeGenCommands(deps: RegisterTypeGenCommandsDeps): vscode.Disposable[] {
  const { profileStore, fmClient, typeGenService, settingsService, logger } = deps;

  return [
    vscode.commands.registerCommand(
      'filemakerDataApiTools.generateTypesForLayout',
      async (arg: unknown) => {
        if (!ensureTrustedWorkspace()) {
          return;
        }

        const contextArg = parseLayoutArg(arg);
        const profile = await resolveProfileFromArg(contextArg, profileStore, true);
        if (!profile) {
          return;
        }

        const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
        if (!layout) {
          return;
        }

        try {
          const artifact = await typeGenService.generateTypesForLayout(profile, layout);
          await openGeneratedFile(artifact.filePath);
          vscode.window.showInformationMessage(
            localize('commands.typeGen.layout.success', 'Generated types for {0}.', layout)
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.typeGen.layout.failed',
              'Type generation failed for layout.'
            ),
            logger,
            logMessage: 'Type generation failed for layout.'
          });
        }
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.generateTypesForAllLayouts',
      async (arg: unknown) => {
        if (!ensureTrustedWorkspace()) {
          return;
        }

        const profile = await resolveProfileFromArg(arg, profileStore, true);
        if (!profile) {
          return;
        }

        try {
          const artifacts = await typeGenService.generateTypesForAllLayouts(profile);
          vscode.window.showInformationMessage(
            localize(
              'commands.typeGen.allLayouts.success',
              'Generated {0} layout type files.',
              artifacts.length
            )
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.typeGen.allLayouts.failed',
              'Type generation failed for all layouts.'
            ),
            logger,
            logMessage: 'Type generation failed for all layouts.'
          });
        }
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.generateSnippetsForLayout',
      async (arg: unknown) => {
        if (!ensureTrustedWorkspace()) {
          return;
        }

        const contextArg = parseLayoutArg(arg);
        const profile = await resolveProfileFromArg(contextArg, profileStore, true);
        if (!profile) {
          return;
        }

        const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
        if (!layout) {
          return;
        }

        try {
          const artifact = await typeGenService.generateSnippetsForLayout(profile, layout);
          await openGeneratedFile(artifact.filePath);
          vscode.window.showInformationMessage(
            localize('commands.typeGen.snippets.success', 'Generated snippets for {0}.', layout)
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.typeGen.snippets.failed',
              'Snippet generation failed.'
            ),
            logger,
            logMessage: 'Snippet generation failed.'
          });
        }
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.openGeneratedTypesFolder', async () => {
      if (!ensureTrustedWorkspace()) {
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage(
          localize('commands.typeGen.openWorkspaceFirst', 'Open a workspace folder first.')
        );
        return;
      }

      const outputDir = settingsService.getTypegenOutputDir();

      const uri = vscode.Uri.file(join(workspaceFolder.uri.fsPath, outputDir));
      await vscode.workspace.fs.createDirectory(uri);
      await vscode.commands.executeCommand('revealFileInOS', uri);
    })
  ];
}

function ensureTrustedWorkspace(): boolean {
  if (vscode.workspace.isTrusted) {
    return true;
  }

  void vscode.window
    .showWarningMessage(
      localize(
        'commands.typeGen.untrusted',
        'Workspace is untrusted. File output generation is disabled. Trust the workspace to enable this feature.'
      ),
      localize('commands.typeGen.learnMore', 'Learn More')
    )
    .then((selection) => {
      if (selection === localize('commands.typeGen.learnMore', 'Learn More')) {
        void vscode.env.openExternal(
          vscode.Uri.parse('https://code.visualstudio.com/docs/editor/workspace-trust')
        );
      }
    });

  return false;
}

async function openGeneratedFile(path: string): Promise<void> {
  const uri = vscode.Uri.file(path);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });

  const directory = vscode.Uri.file(dirname(path));
  await vscode.workspace.fs.createDirectory(directory);
}
