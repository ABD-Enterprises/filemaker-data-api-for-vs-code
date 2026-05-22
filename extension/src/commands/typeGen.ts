import * as vscode from 'vscode';
import { dirname, join } from 'path';

import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SettingsService } from '../services/settingsService';
import type { TypeGenService } from '../services/typeGenService';
import type { ConnectionProfile } from '../types/fm';
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
    vscode.commands.registerCommand('filemakerDataApiTools.generateTypesForLayout', async (arg: unknown) => {
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
        vscode.window.showInformationMessage(`Generated types for ${layout}.`);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Type generation failed for layout.',
          logger,
          logMessage: 'Type generation failed for layout.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.generateTypesForAllLayouts', async (arg: unknown) => {
      if (!ensureTrustedWorkspace()) {
        return;
      }

      const profile = await resolveProfileFromArg(arg, profileStore, true);
      if (!profile) {
        return;
      }

      try {
        const artifacts = await typeGenService.generateTypesForAllLayouts(profile);
        vscode.window.showInformationMessage(`Generated ${artifacts.length} layout type files.`);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Type generation failed for all layouts.',
          logger,
          logMessage: 'Type generation failed for all layouts.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.generateSnippetsForLayout', async (arg: unknown) => {
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
        vscode.window.showInformationMessage(`Generated snippets for ${layout}.`);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Snippet generation failed.',
          logger,
          logMessage: 'Snippet generation failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.generateTypeScriptClient', async (arg: unknown) => {
      if (!ensureTrustedWorkspace()) {
        return;
      }

      const contextArg = parseLayoutArg(arg);
      const profile = await resolveProfileFromArg(contextArg, profileStore, true);
      if (!profile) {
        return;
      }

      const layouts = contextArg.layout
        ? [contextArg.layout]
        : await promptForLayouts(profile, fmClient);
      if (!layouts || layouts.length === 0) {
        return;
      }

      const outputDirectory = await promptForOutputDirectory();
      if (!outputDirectory) {
        return;
      }

      try {
        const artifacts = await typeGenService.generateTypeScriptClient(
          profile,
          layouts,
          outputDirectory
        );
        await openGeneratedFile(artifacts.readmePath);
        vscode.window.showInformationMessage(
          `Generated TypeScript client for ${artifacts.layouts.length} layout${artifacts.layouts.length === 1 ? '' : 's'}.`
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'TypeScript client generation failed.',
          logger,
          logMessage: 'TypeScript client generation failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.openGeneratedTypesFolder', async () => {
      if (!ensureTrustedWorkspace()) {
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      const outputDir = settingsService.getTypegenOutputDir();

      const uri = vscode.Uri.file(join(workspaceFolder.uri.fsPath, outputDir));
      await vscode.workspace.fs.createDirectory(uri);
      await vscode.commands.executeCommand('revealFileInOS', uri);
    })
  ];
}

async function promptForLayouts(profile: ConnectionProfile, fmClient: FMClient): Promise<string[] | undefined> {
  const layouts = await fmClient.listLayouts(profile);
  const picks = await vscode.window.showQuickPick(
    layouts.map((layout) => ({ label: layout })),
    {
      canPickMany: true,
      placeHolder: 'Choose layouts to include in the generated TypeScript client'
    }
  );

  return picks?.map((pick) => pick.label);
}

async function promptForOutputDirectory(): Promise<string | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: workspaceFolder?.uri,
    openLabel: 'Generate Client Here',
    title: 'Choose TypeScript client output folder'
  });

  return uris?.[0]?.fsPath;
}

function ensureTrustedWorkspace(): boolean {
  if (vscode.workspace.isTrusted) {
    return true;
  }

  void vscode.window.showWarningMessage(
    'Workspace is untrusted. File output generation is disabled. Trust the workspace to enable this feature.',
    'Learn More'
  ).then((selection) => {
    if (selection === 'Learn More') {
      void vscode.env.openExternal(vscode.Uri.parse('https://code.visualstudio.com/docs/editor/workspace-trust'));
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
