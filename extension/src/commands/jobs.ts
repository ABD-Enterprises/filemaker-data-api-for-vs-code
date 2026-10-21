import * as vscode from 'vscode';

import { jobStatusText, type JobRunner } from '../services/jobRunner';
import type { JobSummary } from '../types/fm';
import { openJsonDocument } from './common';

interface RegisterJobsCommandsDeps {
  jobRunner: JobRunner;
}

export function registerJobsCommands({ jobRunner }: RegisterJobsCommandsDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('filemakerDataApiTools.cancelJob', async (arg?: { jobId?: string }) => {
      let id = arg?.jobId;
      if (!id) {
        const running = jobRunner.listJobs().filter((job) => ['running', 'queued'].includes(job.status));
        if (!running.length) { vscode.window.showInformationMessage('No running jobs to cancel.'); return; }
        id = (await vscode.window.showQuickPick(running.map((job) => ({ label: job.name, description: job.details, id: job.id })), { title: 'Cancel Job' }))?.id;
      }
      if (id && jobRunner.cancelJob(id)) vscode.window.showInformationMessage('Cancellation requested. Requests already sent will finish; partial results will be kept.');
    }),
    vscode.commands.registerCommand('filemakerDataApiTools.showJobs', async (arg?: { jobId?: string }) => {
      const active = jobRunner.listJobs();
      const ids = new Set(active.map((job) => job.id));
      const recent = jobRunner.getRecentSummaries().filter((job) => !ids.has(job.id));
      const jobs: JobSummary[] = [...active, ...recent];
      if (!jobs.length) { vscode.window.showInformationMessage('No jobs found.'); return; }
      const picked = arg?.jobId ? jobs.find((job) => job.id === arg.jobId) : undefined;
      const selection = picked ? { id: picked.id } : await vscode.window.showQuickPick([
        ...(active.some((job) => ['queued', 'running'].includes(job.status)) ? [{ label: 'Cancel Job', id: 'cancel' }] : []),
        ...jobs.map((job) => ({ label: `${job.name} (${jobStatusText(job)})`, description: `${job.progress}%`,
          detail: `Started ${job.startedAt}${job.finishedAt ? ` • Finished ${job.finishedAt}` : ''}${job.details ? ` • ${job.details}` : ''}`, id: job.id }))
      ], { title: 'FileMaker Jobs' });
      if (!selection) return;
      if (selection.id === 'cancel') { await vscode.commands.executeCommand('filemakerDataApiTools.cancelJob'); return; }
      const job = jobs.find((item) => item.id === selection.id);
      if (!job) return;
      const failures = jobFailures(job);
      const action = await vscode.window.showQuickPick([
        { label: 'View details', id: 'view' },
        ...(failures.length ? [{ label: 'Copy failures', description: `${failures.length} failed rows`, id: 'copy' }] : []),
        ...(['queued', 'running'].includes(job.status) ? [{ label: 'Cancel Job', id: 'cancel' }] : [])
      ], { title: `${job.name}: ${jobStatusText(job)}${job.details && jobStatusText(job) !== job.details ? ` • ${job.details}` : ''}` });
      if (action?.id === 'cancel') await vscode.commands.executeCommand('filemakerDataApiTools.cancelJob', { jobId: job.id });
      if (action?.id === 'copy') await vscode.env.clipboard.writeText(JSON.stringify(failures, null, 2));
      if (action?.id === 'view') await openJsonDocument(job);
    })
  ];
}

function jobFailures(job: JobSummary): unknown[] {
  const result = job.result as { failures?: unknown[] } | undefined;
  return Array.isArray(result?.failures) ? result.failures : [];
}
