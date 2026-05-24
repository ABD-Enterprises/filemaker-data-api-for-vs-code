import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { FmBridgeServer } from '../services/fmBridgeServer';
import type { FmWebProjectService } from '../services/fmWebProjectService';
import type { FmWebRuntimeGenerator } from '../services/fmWebRuntimeGenerator';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SchemaService } from '../services/schemaService';
import { localize } from '../i18n';
import { LayoutModePanel } from '../webviews/layoutMode';
import { resolveProfileFromArg, pickProfile, showCommandError } from './common';

interface RegisterFmWebProjectCommandDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  fmClient: FMClient;
  schemaService: SchemaService;
  fmWebProjectService: FmWebProjectService;
  fmWebRuntimeGenerator: FmWebRuntimeGenerator;
  fmBridgeServer: FmBridgeServer;
  logger: Logger;
  refreshExplorer: () => void;
}

export function registerFmWebProjectCommands(
  deps: RegisterFmWebProjectCommandDeps
): vscode.Disposable[] {
  const {
    context,
    profileStore,
    fmClient,
    schemaService,
    fmWebProjectService,
    fmWebRuntimeGenerator,
    fmBridgeServer,
    logger,
    refreshExplorer
  } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.initializeFmWebProject', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          localize(
            'commands.fmWeb.initialize.workspaceTrustRequired',
            'Workspace trust is required to initialize an FM Web project.'
          )
        );
        return;
      }

      try {
        const project = await fmWebProjectService.initializeProject();
        vscode.window.showInformationMessage(
          localize(
            'commands.fmWeb.initialize.success',
            'Initialized FM Web project at .fmweb ({0}).',
            project.name
          )
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: localize(
            'commands.fmWeb.initialize.failed',
            'Failed to initialize FM Web project.'
          ),
          logger,
          logMessage: 'Initialize FM Web project command failed.'
        });
      }
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.selectActiveProfile',
      async (arg: unknown) => {
        const resolved = await resolveProfileFromArg(arg, profileStore, true);
        const profile = resolved ?? (await pickProfile(profileStore, true));
        if (!profile) {
          return;
        }

        try {
          await fmWebProjectService.setActiveProfile(profile.id);
          refreshExplorer();
          vscode.window.showInformationMessage(
            localize(
              'commands.fmWeb.selectActiveProfile.success',
              'Selected active profile: {0}.',
              profile.name
            )
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.fmWeb.selectActiveProfile.failed',
              'Failed to set active profile for FM Web project.'
            ),
            logger,
            logMessage: 'Select active profile command failed.'
          });
        }
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.syncFmWebMetadata',
      async (arg: unknown) => {
        if (!vscode.workspace.isTrusted) {
          vscode.window.showWarningMessage(
            localize(
              'commands.fmWeb.syncMetadata.workspaceTrustRequired',
              'Workspace trust is required to sync FM Web metadata.'
            )
          );
          return;
        }

        const profile = await resolveProfileFromArg(arg, profileStore, true);
        if (!profile) {
          return;
        }

        try {
          await fmWebProjectService.setActiveProfile(profile.id);
          const summary = await fmWebProjectService.syncMetadata(profile);
          schemaService.invalidateProfile(profile.id);
          fmClient.invalidateProfileCache(profile.id);
          refreshExplorer();

          vscode.window.showInformationMessage(
            localize(
              'commands.fmWeb.syncMetadata.success',
              'Metadata synced: {0} layouts, {1} scripts, {2} fields.',
              summary.layoutCount,
              summary.scriptCount,
              summary.fieldCount
            )
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.fmWeb.syncMetadata.failed',
              'Failed to sync FM Web metadata.'
            ),
            logger,
            logMessage: 'Sync FM Web metadata command failed.'
          });
        }
      }
    ),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.openLayoutMode',
      async (arg: unknown) => {
        if (!vscode.workspace.isTrusted) {
          vscode.window.showWarningMessage(
            localize(
              'commands.fmWeb.openLayoutMode.workspaceTrustRequired',
              'Workspace trust is required for Layout Mode because layout files are written to .fmweb.'
            )
          );
          return;
        }

        try {
          await fmWebProjectService.ensureProjectInitialized();

          const record =
            arg && typeof arg === 'object' && !Array.isArray(arg)
              ? (arg as Record<string, unknown>)
              : undefined;
          const layoutId = typeof record?.layoutId === 'string' ? record.layoutId : undefined;

          LayoutModePanel.createOrShow(
            context,
            fmWebProjectService,
            profileStore,
            fmClient,
            logger,
            {
              layoutId
            }
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.fmWeb.openLayoutMode.failed',
              'Failed to open Layout Mode.'
            ),
            logger,
            logMessage: 'Open Layout Mode command failed.'
          });
        }
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.generateFmWebNextApp', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          localize(
            'commands.fmWeb.generateNextApp.workspaceTrustRequired',
            'Workspace trust is required to generate the FM Web runtime template.'
          )
        );
        return;
      }

      try {
        const summary = await fmWebRuntimeGenerator.generateRuntimeAppTemplate();
        vscode.window.showInformationMessage(
          localize(
            'commands.fmWeb.generateNextApp.success',
            'Generated Next.js runtime template in .fmweb/generated/runtime-next ({0} created, {1} skipped).',
            summary.created.length,
            summary.skipped.length
          )
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: localize(
            'commands.fmWeb.generateNextApp.failed',
            'Failed to generate FM Web Next.js runtime template.'
          ),
          logger,
          logMessage: 'Generate FM Web Next.js runtime template command failed.'
        });
      }
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.generateFmWebLayoutPage',
      async (arg: unknown) => {
        if (!vscode.workspace.isTrusted) {
          vscode.window.showWarningMessage(
            localize(
              'commands.fmWeb.generateLayout.workspaceTrustRequired',
              'Workspace trust is required to generate FM Web layout runtime artifacts.'
            )
          );
          return;
        }

        try {
          const layouts = await fmWebRuntimeGenerator.listLayoutDefinitions();
          if (layouts.length === 0) {
            vscode.window.showWarningMessage(
              localize(
                'commands.fmWeb.generateLayout.noDefinitions',
                'No layout definitions were found. Save a layout first.'
              )
            );
            return;
          }

          const selectedId =
            extractLayoutIdArg(arg) ??
            (
              await vscode.window.showQuickPick(
                layouts.map((layout) => ({
                  label: layout.name,
                  description: layout.id,
                  id: layout.id
                })),
                {
                  title: localize(
                    'commands.fmWeb.generateLayout.title',
                    'Generate Runtime Layout Artifact'
                  ),
                  placeHolder: localize(
                    'commands.fmWeb.generateLayout.placeholder',
                    'Choose a layout to generate'
                  )
                }
              )
            )?.id;

          if (!selectedId) {
            return;
          }

          const generated = await fmWebRuntimeGenerator.generateLayoutPage(selectedId);
          vscode.window.showInformationMessage(
            localize(
              'commands.fmWeb.generateLayout.success',
              'Generated layout artifact for "{0}" at .fmweb/generated/layouts/{1}.layout.json.',
              generated.name,
              generated.id
            )
          );
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.fmWeb.generateLayout.failed',
              'Failed to generate FM Web layout runtime artifact.'
            ),
            logger,
            logMessage: 'Generate FM Web layout runtime artifact command failed.'
          });
        }
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.startFmWebPreviewServer', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          localize(
            'commands.fmWeb.startPreview.workspaceTrustRequired',
            'Workspace trust is required to start FM Web preview services.'
          )
        );
        return;
      }

      try {
        await fmWebRuntimeGenerator.generateRuntimeAppTemplate();
        const layouts = await fmWebRuntimeGenerator.listLayoutDefinitions();
        const firstLayout = layouts[0];
        if (firstLayout) {
          await fmWebRuntimeGenerator.generateLayoutPage(firstLayout.id);
        }

        const bridge = await fmBridgeServer.ensureStarted();
        await fmWebRuntimeGenerator.writeBridgeEnv(bridge.baseUrl);

        const runtimeRoot = fmWebRuntimeGenerator.getGeneratedRuntimeRoot();
        const terminal = vscode.window.createTerminal({
          name: localize('commands.fmWeb.startPreview.terminalName', 'FM Web Preview'),
          cwd: runtimeRoot
        });
        terminal.show(true);
        terminal.sendText('npm install --no-audit --no-fund');
        terminal.sendText('npm run dev');

        vscode.window.showInformationMessage(
          localize(
            'commands.fmWeb.startPreview.success',
            'FM bridge ready at {0}. Preview app starting from .fmweb/generated/runtime-next.',
            bridge.baseUrl
          )
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: localize(
            'commands.fmWeb.startPreview.failed',
            'Failed to start FM Web preview server.'
          ),
          logger,
          logMessage: 'Start FM Web preview server command failed.'
        });
      }
    })
  ];
}

function extractLayoutIdArg(arg: unknown): string | undefined {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    return undefined;
  }

  const raw = (arg as Record<string, unknown>).layoutId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}
