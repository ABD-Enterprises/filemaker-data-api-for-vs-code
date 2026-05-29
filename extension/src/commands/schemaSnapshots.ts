import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import {
  diffSchemaFieldsInWorker,
  diffSchemaSnapshotsInWorker,
  SchemaDiffCancelledError
} from '../services/schemaDiff';
import type { SchemaSnapshotStore } from '../services/schemaSnapshotStore';
import type { SchemaService } from '../services/schemaService';
import { extractFieldsFromMetadata } from '../services/schemaService';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SettingsService } from '../services/settingsService';
import type { SchemaDiffResult, SchemaSnapshot } from '../types/fm';
import {
  openJsonDocument,
  parseLayoutArg,
  promptForLayout,
  resolveProfileFromArg,
  showCommandError
} from './common';
import { SchemaDiffPanel } from '../webviews/schemaDiff';

interface RegisterSchemaSnapshotCommandsDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  fmClient: FMClient;
  schemaService: SchemaService;
  snapshotStore: SchemaSnapshotStore;
  settingsService: SettingsService;
  logger: Logger;
  refreshExplorer: () => void;
  diagnostics: vscode.DiagnosticCollection;
}

export function registerSchemaSnapshotCommands(
  deps: RegisterSchemaSnapshotCommandsDeps
): vscode.Disposable[] {
  const {
    context,
    profileStore,
    fmClient,
    schemaService,
    snapshotStore,
    settingsService,
    logger,
    refreshExplorer,
    diagnostics
  } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.captureSchemaSnapshot', async (arg: unknown) => {
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
        const schema = await schemaService.getLayoutSchema(profile, layout);
        if (!schema.supported || !schema.metadata) {
          vscode.window.showInformationMessage(
            schema.message ?? 'Metadata is not available on this server/profile.'
          );
          return;
        }

        const snapshot = await snapshotStore.captureSnapshot({
          profileId: profile.id,
          layout,
          source: 'manual',
          metadata: schema.metadata
        });

        refreshExplorer();
        vscode.window.showInformationMessage(
          `Captured schema snapshot ${snapshot.id.slice(0, 8)} for ${layout}.`
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to capture schema snapshot.',
          logger,
          logMessage: 'Failed to capture schema snapshot.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.diffSchemaSnapshots', async (arg: unknown) => {
      const contextArg = parseLayoutArg(arg);
      const profile = await resolveProfileFromArg(contextArg, profileStore, true);
      if (!profile) {
        return;
      }

      const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
      if (!layout) {
        return;
      }

      const snapshots = await snapshotStore.listSnapshots({
        profileId: profile.id,
        layout
      });
      if (snapshots.length < 2) {
        vscode.window.showInformationMessage('At least two snapshots are required to diff.');
        return;
      }

      const older = await pickSnapshot('Select older snapshot', snapshots);
      if (!older) {
        return;
      }

      const newer = await pickSnapshot(
        'Select newer snapshot',
        snapshots.filter((snapshot) => snapshot.id !== older.id)
      );
      if (!newer) {
        return;
      }

      const olderSnapshot = await snapshotStore.getSnapshot(older.id);
      const newerSnapshot = await snapshotStore.getSnapshot(newer.id);
      if (!olderSnapshot || !newerSnapshot) {
        vscode.window.showErrorMessage('Unable to load one or both selected snapshots.');
        return;
      }

      try {
        const diff = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Diffing schema snapshots',
            cancellable: true
          },
          (_progress, token) =>
            diffSchemaSnapshotsInWorker(
              olderSnapshot,
              newerSnapshot,
              extractFieldsFromMetadata(olderSnapshot.metadata),
              extractFieldsFromMetadata(newerSnapshot.metadata),
              token
            )
        );

        SchemaDiffPanel.createOrShow(context, diff);
      } catch (error) {
        if (error instanceof SchemaDiffCancelledError) {
          logger.info('Schema snapshot diff was cancelled.');
          return;
        }

        await showCommandError(error, {
          fallbackMessage: 'Failed to diff schema snapshots.',
          logger,
          logMessage: 'Failed to diff selected schema snapshots.'
        });
      }
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.diffAgainstLatestSnapshot',
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

        const latest = await snapshotStore.getLatestSnapshot(profile.id, layout);
        if (!latest) {
          vscode.window.showInformationMessage('No snapshot found. Capture one first.');
          return;
        }

        try {
          const currentSchema = await schemaService.getLayoutSchema(profile, layout);
          if (!currentSchema.supported || !currentSchema.metadata) {
            vscode.window.showInformationMessage(
              currentSchema.message ?? 'Metadata is not available on this server/profile.'
            );
            return;
          }

          const diff = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Diffing schema against latest snapshot',
              cancellable: true
            },
            (_progress, token) =>
              diffSchemaFieldsInWorker(
                {
                  profileId: profile.id,
                  layout,
                  olderSnapshotId: latest.id,
                  beforeFields: extractFieldsFromMetadata(latest.metadata),
                  afterFields: currentSchema.fields
                },
                token
              )
          );

          SchemaDiffPanel.createOrShow(context, diff);
          publishDiffDiagnosticsIfEnabled(
            diagnostics,
            profile.id,
            layout,
            diff,
            settingsService.isSchemaDiagnosticsEnabled()
          );
        } catch (error) {
          if (error instanceof SchemaDiffCancelledError) {
            logger.info('Schema diff against latest snapshot was cancelled.');
            return;
          }

          await showCommandError(error, {
            fallbackMessage: 'Failed to diff schema against latest snapshot.',
            logger,
            logMessage: 'Failed to diff current schema against latest snapshot.'
          });
        }
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.openSchemaSnapshotJson', async (arg: unknown) => {
      const snapshotId = parseSnapshotId(arg);

      let snapshot: SchemaSnapshot | undefined;
      if (snapshotId) {
        snapshot = await snapshotStore.getSnapshot(snapshotId);
      } else {
        const profile = await resolveProfileFromArg(undefined, profileStore, true);
        if (!profile) {
          return;
        }

        const snapshots = await snapshotStore.listSnapshots({
          profileId: profile.id
        });

        const picked = await pickSnapshot('Open schema snapshot', snapshots);
        if (!picked) {
          return;
        }

        snapshot = await snapshotStore.getSnapshot(picked.id);
      }

      if (!snapshot) {
        vscode.window.showErrorMessage('Snapshot not found.');
        return;
      }

      await openJsonDocument(snapshot);
    })
  ];
}

function parseSnapshotId(arg: unknown): string | undefined {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }

  const record = arg as Record<string, unknown>;
  if (typeof record.snapshotId === 'string') {
    return record.snapshotId;
  }

  return undefined;
}

async function pickSnapshot(
  title: string,
  snapshots: Array<{ id: string; capturedAt: string; layout: string; source: string }>
): Promise<{ id: string; capturedAt: string; layout: string; source: string } | undefined> {
  if (snapshots.length === 0) {
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    snapshots.map((snapshot) => ({
      label: `${snapshot.layout} • ${snapshot.capturedAt}`,
      description: `${snapshot.source} • ${snapshot.id.slice(0, 8)}`,
      snapshot
    })),
    {
      title
    }
  );

  return picked?.snapshot;
}

function publishDiffDiagnosticsIfEnabled(
  diagnostics: vscode.DiagnosticCollection,
  profileId: string,
  layout: string,
  diff: SchemaDiffResult,
  enabled: boolean
): void {
  const uri = vscode.Uri.parse(
    `filemaker-schema://${encodeURIComponent(profileId)}/${encodeURIComponent(layout)}.json`
  );

  if (!enabled) {
    diagnostics.delete(uri);
    return;
  }

  const items: vscode.Diagnostic[] = [];
  const range = new vscode.Range(0, 0, 0, 1);

  for (const field of diff.added) {
    items.push(new vscode.Diagnostic(range, `Schema added field: ${field.name}`, vscode.DiagnosticSeverity.Warning));
  }

  for (const field of diff.removed) {
    items.push(
      new vscode.Diagnostic(range, `Schema removed field: ${field.name}`, vscode.DiagnosticSeverity.Warning)
    );
  }

  for (const field of diff.changed) {
    const attributes = field.changes.map((change) => change.attribute).join(', ');
    items.push(
      new vscode.Diagnostic(
        range,
        `Schema changed field ${field.fieldName}: ${attributes}`,
        vscode.DiagnosticSeverity.Information
      )
    );
  }

  diagnostics.set(uri, items);
}
