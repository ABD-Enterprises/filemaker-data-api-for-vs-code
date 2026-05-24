import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SchemaService } from '../services/schemaService';
import { localize } from '../i18n';
import {
  openJsonDocument,
  parseLayoutArg,
  promptForLayout,
  resolveProfileFromArg,
  showCommandError
} from './common';

interface RegisterSchemaCommandDeps {
  profileStore: ProfileStore;
  fmClient: FMClient;
  schemaService: SchemaService;
  logger: Logger;
  refreshExplorer: () => void;
}

export function registerSchemaCommands(deps: RegisterSchemaCommandDeps): vscode.Disposable[] {
  const { profileStore, fmClient, schemaService, logger, refreshExplorer } = deps;

  return [
    vscode.commands.registerCommand(
      'filemakerDataApiTools.openLayoutMetadata',
      async (arg: unknown) => {
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
          const metadataResult = await schemaService.getLayoutSchema(profile, layout);

          if (!metadataResult.supported) {
            vscode.window.showInformationMessage(
              metadataResult.message ??
                localize(
                  'commands.schema.metadataUnsupported',
                  'Metadata is not supported for this profile/server.'
                )
            );
            return;
          }

          await openJsonDocument({
            profile: profile.name,
            layout,
            metadata: metadataResult.metadata,
            fieldCount: metadataResult.fields.length,
            cached: metadataResult.fromCache
          });
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: localize(
              'commands.schema.openMetadata.failed',
              'Failed to open layout metadata.'
            ),
            logger,
            logMessage: 'Failed to open layout metadata.'
          });
        }
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.refreshSchemaCache', () => {
      schemaService.invalidateAll();
      refreshExplorer();
      vscode.window.showInformationMessage(
        localize('commands.schema.cacheCleared', 'Schema cache cleared.')
      );
    })
  ];
}
