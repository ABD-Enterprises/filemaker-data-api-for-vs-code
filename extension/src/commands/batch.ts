import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { BatchService } from '../services/batchService';
import type { JobRunner } from '../services/jobRunner';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SettingsService } from '../services/settingsService';
import { parseFindJson, parseSortJson } from '../utils/jsonValidate';
import {
  openJsonDocument,
  parseLayoutArg,
  promptForLayout,
  resolveProfileFromArg,
  showCommandError
} from './common';

interface RegisterBatchCommandsDeps {
  profileStore: ProfileStore;
  fmClient: FMClient;
  batchService: BatchService;
  jobRunner: JobRunner;
  roleGuard: RoleGuard;
  settingsService: SettingsService;
  logger: Logger;
}

export function registerBatchCommands(deps: RegisterBatchCommandsDeps): vscode.Disposable[] {
  const { profileStore, fmClient, batchService, jobRunner, roleGuard, settingsService, logger } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.batchExportFind', async (arg: unknown) => {
      if (!(await ensureBatchEnabled(settingsService))) {
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

      const findJsonInput = await vscode.window.showInputBox({
        title: 'Batch Export (Find)',
        prompt: 'Find query JSON array',
        value: '[{}]',
        ignoreFocusOut: true
      });
      if (!findJsonInput) {
        return;
      }

      const sortJsonInput = await vscode.window.showInputBox({
        title: 'Batch Export (Find)',
        prompt: 'Sort JSON array (optional)',
        ignoreFocusOut: true
      });

      const outputUri = await vscode.window.showSaveDialog({
        title: 'Export batch find results',
        defaultUri: vscode.Uri.file(`${layout}.jsonl`),
        filters: {
          JSONL: ['jsonl'],
          CSV: ['csv']
        }
      });
      if (!outputUri) {
        return;
      }

      const findValidation = parseFindJson(findJsonInput);
      if (!findValidation.ok || !findValidation.value) {
        vscode.window.showErrorMessage(findValidation.error ?? 'Invalid find JSON.');
        return;
      }
      const findQuery = findValidation.value;

      let sort: Array<Record<string, unknown>> | undefined;
      if (sortJsonInput && sortJsonInput.trim().length > 0) {
        const sortValidation = parseSortJson(sortJsonInput);
        if (!sortValidation.ok || !sortValidation.value) {
          vscode.window.showErrorMessage(sortValidation.error ?? 'Invalid sort JSON.');
          return;
        }

        sort = sortValidation.value;
      }

      const maxRecords = settingsService.getBatchMaxRecords();

      const performanceMode = roleGuard.resolvePerformanceMode();
      const { inferExportFormat } = await import('../services/batchService');
      const selectedFormat = inferExportFormat(outputUri.fsPath);
      const format = performanceMode === 'high-scale' ? 'jsonl' : selectedFormat;
      const outputPath =
        performanceMode === 'high-scale' && selectedFormat !== 'jsonl'
          ? replaceExtension(outputUri.fsPath, '.jsonl')
          : outputUri.fsPath;

      const job = jobRunner.startJob(`Batch Export ${layout}`, async (jobContext) => {
        jobContext.log('info', `Starting export to ${outputPath}`);

        const result = await batchService.batchExportFind(
          profile,
          layout,
          {
            query: findQuery,
            sort
          },
          {
            outputPath,
            format,
            maxRecords
          },
          jobContext
        );

        jobContext.log(
          'info',
          `Finished export. Records=${result.exportedRecords}, truncated=${result.truncated}`
        );
        return result;
      });

      vscode.window.showInformationMessage(`Started job ${job.id.slice(0, 8)} for batch export.`);
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.batchUpdateFromFile',
      async (arg: unknown) => {
        if (!(await ensureBatchEnabled(settingsService))) {
          return;
        }

        const canUpdate = await roleGuard.assertFeature('batchUpdate', 'Batch update from CSV/JSON');
        if (!canUpdate) {
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

        const filePick = await vscode.window.showOpenDialog({
          title: 'Batch update source file',
          canSelectMany: false,
          filters: {
            JSON: ['json'],
            CSV: ['csv']
          }
        });

        const sourceUri = filePick?.[0];
        if (!sourceUri) {
          return;
        }

        try {
          const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
          const sourceText = Buffer.from(sourceBytes).toString('utf8');
          const format = sourceUri.fsPath.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
          const { parseBatchUpdateInput } = await import('../services/batchService');
          const entries = parseBatchUpdateInput(sourceText, format);
          if (entries.length === 0) {
            vscode.window.showWarningMessage('No valid update rows found.');
            return;
          }

          const defaults = await batchService.getDefaultBatchUpdateOptions();
          const dryRunSelection = await vscode.window.showQuickPick(
            [
              { label: 'Dry-run only (recommended)', value: true },
              { label: 'Execute updates now', value: false }
            ],
            {
              title: 'Batch Update Mode',
              placeHolder: `Default: ${defaults.dryRun ? 'dry-run' : 'execute'}`
            }
          );

          if (!dryRunSelection) {
            return;
          }

          if (!dryRunSelection.value) {
            const confirmation = await vscode.window.showWarningMessage(
              `Execute batch update for ${entries.length} records on ${layout}?\nRollback guidance: keep a pre-update export and rerun updates with previous values to revert.`,
              { modal: true },
              'Execute'
            );

            if (confirmation !== 'Execute') {
              return;
            }
          }

          const concurrency = settingsService.getBatchConcurrency();

          const job = jobRunner.startJob(`Batch Update ${layout}`, async (jobContext) => {
            jobContext.log(
              'info',
              `Starting batch update from ${sourceUri.fsPath} (dryRun=${dryRunSelection.value})`
            );

            const result = await batchService.batchUpdate(
              profile,
              layout,
              entries,
              {
                dryRun: dryRunSelection.value,
                concurrency
              },
              jobContext
            );

            jobContext.log(
              'info',
              `Batch update completed. Attempted=${result.attempted}, success=${result.successCount}, failures=${result.failureCount}`
            );

            return result;
          });

          vscode.window.showInformationMessage(`Started job ${job.id.slice(0, 8)} for batch update.`);

          if (dryRunSelection.value) {
            const preview = {
              dryRun: true,
              totalEntries: entries.length,
              layout,
              sample: entries.slice(0, 5)
            };
            await openJsonDocument(preview);
          }
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: 'Batch update failed to start.',
            logger,
            logMessage: 'Batch update failed to start.'
          });
        }
      }
    )
  ];
}

async function ensureBatchEnabled(settingsService: SettingsService): Promise<boolean> {
  const enabled = settingsService.isBatchEnabled();
  if (!enabled || !vscode.workspace.isTrusted) {
    void vscode.window
      .showInformationMessage(
        'Batch operations are disabled in settings or untrusted workspace mode.',
        'Learn More'
      )
      .then((selection) => {
        if (selection === 'Learn More') {
          void vscode.env.openExternal(
            vscode.Uri.parse('https://code.visualstudio.com/docs/editor/workspace-trust')
          );
        }
      });
    return false;
  }

  return true;
}

function replaceExtension(path: string, extension: string): string {
  if (path.toLowerCase().endsWith(extension.toLowerCase())) {
    return path;
  }

  const withoutExt = path.replace(/\.[A-Za-z0-9]+$/, '');
  return `${withoutExt}${extension}`;
}
