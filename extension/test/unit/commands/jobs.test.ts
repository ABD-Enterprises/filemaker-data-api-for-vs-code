import { beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerJobsCommands } from '../../../src/commands/jobs';
import { FMExplorerProvider, FMExplorerItem } from '../../../src/views/fmExplorer';
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

it.each([
  [{ cancelled: true, total: 5, attempted: 2 }, 'Cancelled after 2 of 5'],
  [{ cancelled: true, exportedRecords: 7 }, 'Cancelled after exporting 7 records'],
  [undefined, 'Cancelled'],
  ['throw', 'Cancelled']
])('finalizes cancellation text across tree, quick pick and saved history (%j)', async (result, expected) => {
  const memento = new InMemoryMemento();
  const runner = new JobRunner(memento as never);
  let finish!: () => void;
  const handle = runner.startJob('Cancel test', async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    if (result === 'throw') throw new Error('request failed after cancellation');
    return result;
  });
  handle.cancel(); finish();
  await new Promise((resolve) => setImmediate(resolve));
  expect(handle.getState().details).toBe(expected);
  expect(runner.getRecentSummaries()[0]?.details).toBe(expected);
  const explorer = new FMExplorerProvider({} as never, {} as never, {} as never, {} as never, {} as never, runner, {} as never, {} as never, {} as never);
  const tree = await explorer.getChildren(new FMExplorerItem({ kind: 'jobsRoot', label: 'Jobs' }));
  expect(tree[0]?.description).toContain(expected);
  expect(tree[0]?.tooltip).toContain(expected);
  expect(JSON.stringify(tree)).not.toContain('Cancelling');
  for (const source of [runner, new JobRunner(memento as never)]) {
    registerJobsCommands({ jobRunner: source });
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce((async (items: Array<{ label: string; detail: string }>) => {
      expect(items[0]?.label).toBe(`Cancel test (${expected})`);
      expect(items[0]?.detail).toContain(expected);
      expect(JSON.stringify(items)).not.toContain('Cancelling');
      return items[0];
    }) as never).mockResolvedValueOnce(undefined);
    await command('showJobs')();
    expect(vscode.window.showQuickPick).toHaveBeenLastCalledWith(expect.any(Array), { title: `Cancel test: ${expected}` });
  }
});

it('redacts copied failures identically for live and restored jobs', async () => {
  const memento = new InMemoryMemento();
  const runner = new JobRunner(memento as never);
  const handle = runner.startJob('Sensitive failure', async () => ({ failures: [{ recordId: '2', code: '301', token: 'private-token', reason: 'Bearer private-secret' }] }));
  await new Promise((resolve) => setImmediate(resolve));
  for (const source of [runner, new JobRunner(memento as never)]) {
    registerJobsCommands({ jobRunner: source });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ id: 'copy' } as never);
    await command('showJobs')({ jobId: handle.id });
    expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith(JSON.stringify([{ recordId: '2', code: '301', token: '***', reason: 'Bearer ***' }], null, 2));
  }
});
