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
  vi.mocked(vscode.window.showQuickPick).mockImplementationOnce((async (items: Array<{ id: string; label: string; detail: string }>) => {
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toContain('completed with 1 failed row');
    expect(items[0]?.detail).toContain('2 succeeded, 1 failed');
    return items[0];
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
  expect(handle.getState().status).toBe('cancelling');
  expect(runner.getRecentSummaries()).toHaveLength(0);
  vi.mocked(vscode.window.showQuickPick).mockImplementationOnce((async (items: Array<{ label: string }>) => {
    expect(items.map((item) => item.label)).toEqual(['View details']); return undefined;
  }) as never);
  await command('showJobs')({ jobId: handle.id });
  finish(); await new Promise((resolve) => setImmediate(resolve));
  expect(handle.getState().status).toBe('cancelled');
});

it('copies failures and opens partial results from persisted history after cancellation', async () => {
  const memento = new InMemoryMemento();
  const runner = new JobRunner(memento as never);
  const result = { total: 4, attempted: 2, successCount: 1, failureCount: 1,
    updatedIds: ['1'], failures: [{ recordId: '2', code: '301', reason: 'FileMaker 301: Record in use' }],
    notAttemptedIds: ['3', '4'], notAttempted: 2 };
  let finish!: (value: typeof result) => void;
  const handle = runner.startJob('Partial update', () => new Promise<typeof result>((resolve) => { finish = resolve; }));
  handle.cancel();
  finish(result);
  await new Promise((resolve) => setImmediate(resolve));
  registerJobsCommands({ jobRunner: new JobRunner(memento as never) });
  vi.mocked(vscode.window.showQuickPick).mockImplementationOnce((async (items: Array<{ label: string }>) => {
    expect(items.map((item) => item.label)).toEqual(['View details', 'Copy failures']);
    return { id: 'copy' };
  }) as never);
  await command('showJobs')({ jobId: handle.id });
  expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify(result.failures, null, 2));
  vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ id: 'view' } as never);
  await command('showJobs')({ jobId: handle.id });
  expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('"notAttemptedIds"')
  }));
});
