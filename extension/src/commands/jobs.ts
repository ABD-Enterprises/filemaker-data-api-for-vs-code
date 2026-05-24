import * as vscode from 'vscode';

import { localize } from '../i18n';
import type { JobRunner } from '../services/jobRunner';
import { openJsonDocument } from './common';

interface RegisterJobsCommandsDeps {
  jobRunner: JobRunner;
}

export function registerJobsCommands(deps: RegisterJobsCommandsDeps): vscode.Disposable[] {
  const { jobRunner } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.showJobs', async () => {
      const active = jobRunner.listJobs();
      const recent = jobRunner.getRecentSummaries();

      if (active.length === 0 && recent.length === 0) {
        vscode.window.showInformationMessage(localize('commands.jobs.noneFound', 'No jobs found.'));
        return;
      }

      const picked = await vscode.window.showQuickPick(
        [
          ...active.map((job) => ({
            label: `${job.name} (${job.status})`,
            description: `${job.progress}%`,
            detail: localize(
              'commands.jobs.activeDetail',
              'Started {0}{1}',
              job.startedAt,
              job.details ? ` • ${job.details}` : ''
            ),
            value: { kind: 'active' as const, id: job.id }
          })),
          ...recent.map((job) => ({
            label: `${job.name} (${job.status})`,
            description: `${job.progress}%`,
            detail: localize(
              'commands.jobs.recentDetail',
              'Started {0}{1}',
              job.startedAt,
              job.finishedAt
                ? localize('commands.jobs.finishedSuffix', ' • Finished {0}', job.finishedAt)
                : ''
            ),
            value: { kind: 'recent' as const, id: job.id }
          }))
        ],
        {
          title: localize('commands.jobs.title', 'FileMaker Jobs')
        }
      );

      if (!picked) {
        return;
      }

      if (picked.value.kind === 'active') {
        const job = active.find((item) => item.id === picked.value.id);
        if (job) {
          await openJsonDocument(job);
        }
        return;
      }

      const job = recent.find((item) => item.id === picked.value.id);
      if (job) {
        await openJsonDocument(job);
      }
    })
  ];
}
