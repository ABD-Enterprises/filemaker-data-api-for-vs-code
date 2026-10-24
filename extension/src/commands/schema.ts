import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SchemaService } from '../services/schemaService';
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
    vscode.commands.registerCommand('filemakerDataApiTools.openLayoutMetadata', async (arg: unknown) => {
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
            metadataResult.message ?? 'Metadata is not supported for this profile/server.'
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
          fallbackMessage: 'Failed to open layout metadata.',
          logger,
          logMessage: 'Failed to open layout metadata.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.refreshSchemaCache', async () => {
      schemaService.invalidateAll();
      // The layout list, layout metadata and their validators live in the client, not in the schema
      // service; drop them too, or the next refresh would be served the old list.
      try {
        for (const profile of await profileStore.listProfiles()) {
          fmClient.invalidateProfileCache(profile.id);
        }
      } catch (error) {
        logger.warn('Could not clear the layout caches while refreshing the schema cache.', { error });
      }
      refreshExplorer();
      vscode.window.showInformationMessage('Schema cache cleared; layouts will be read again.');
    })
  ];
}
