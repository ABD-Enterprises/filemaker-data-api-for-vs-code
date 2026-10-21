import { beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerJobsCommands } from '../../../src/commands/jobs';
import { JobRunner } from '../../../src/services/jobRunner';
import { InMemoryMemento } from '../mocks';
import { command } from '../../helpers/commandHarness';

beforeEach(() => vi.clearAllMocks());
it('shows a completed job once and copies failed rows including the FileMaker code', async () => {
  const runner = new JobRunner(new InMemoryMemento() as never);
  const failures = [{ recordId: '2', code: '1708', reason: 'FileMaker 1708: bad value' }];
  runner.startJob('Update', async () => ({ successCount: 2, failureCount: 1, failures }));
  await new Promise((resolve) => setImmediate(resolve));
  registerJobsCommands({ jobRunner: runner });
  vi.mocked(vscode.window.showQuickPick).mockImplementationOnce((async (items: Array<{ id: string }>) => {
    expect(items).toHaveLength(1); return items[0];
  }) as never).mockResolvedValueOnce({ id: 'copy' } as never);
  await command('showJobs')();
  expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify(failures, null, 2));
});
it('offers Cancel Job in the jobs menu and cancels by tree item id', async () => {
  const runner = new JobRunner(new InMemoryMemento() as never);
  let finish!: () => void;
  const handle = runner.startJob('Running', () => new Promise<void>((resolve) => { finish = resolve; }));
  registerJobsCommands({ jobRunner: runner });
  vi.mocked(vscode.window.showQuickPick).mockImplementationOnce((async (items: Array<{ label: string }>) => {
    expect(items.some((item) => item.label === 'Cancel Job')).toBe(true); return undefined;
  }) as never);
  await command('showJobs')();
  await command('cancelJob')({ jobId: handle.id });
  finish(); await new Promise((resolve) => setImmediate(resolve));
  expect(handle.getState().status).toBe('cancelled');
});
