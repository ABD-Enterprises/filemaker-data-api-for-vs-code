import { describe, expect, it } from 'vitest';

import { JobRunner } from '../../src/services/jobRunner';
import { InMemoryMemento } from './mocks';

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('JobRunner', () => {
  it('runs jobs and persists summaries', async () => {
    const memento = new InMemoryMemento();
    const runner = new JobRunner(memento as never);

    const handle = runner.startJob('Example Job', async (context) => {
      context.reportProgress(25, 'starting');
      context.reportProgress(100, 'done');
      return { ok: true };
    });

    await waitFor(() => handle.getState().status === 'completed');

    const state = handle.getState();
    expect(state.status).toBe('completed');
    expect(state.progress).toBe(100);

    const recent = runner.getRecentSummaries();
    expect(recent).toHaveLength(1);
    const first = recent.at(0);
    expect(first?.name).toBe('Example Job');
  });

  it('supports cancellation', async () => {
    const memento = new InMemoryMemento();
    const runner = new JobRunner(memento as never);

    const handle = runner.startJob('Cancelable', async (context) => {
      for (let i = 0; i < 50; i += 1) {
        if (context.isCancellationRequested()) {
          return;
        }

        context.reportProgress(i * 2);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });

    handle.cancel();
    await waitFor(() => handle.getState().status === 'cancelled');
    expect(handle.getState().status).toBe('cancelled');
  });
});

describe('job outcomes', () => {
  it('retains partial results when cancelled and drains before persisting', async () => {
    const runner = new JobRunner(new InMemoryMemento() as never);
    let finish!: (value: { successCount: number }) => void;
    const handle = runner.startJob('Partial', () => new Promise((resolve) => { finish = resolve; }));
    handle.cancel(); finish({ successCount: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(handle.getState()).toMatchObject({ status: 'cancelled', result: { successCount: 2 } });
  });
  it('reports row failures explicitly and preserves them in recent history', async () => {
    const runner = new JobRunner(new InMemoryMemento() as never);
    const result = { total: 3, attempted: 3, successCount: 2, failureCount: 1, failures: [{ recordId: '2', reason: 'FileMaker 1708: invalid value' }] };
    const handle = runner.startJob('Batch', async () => result);
    await new Promise((resolve) => setImmediate(resolve));
    expect(handle.getState()).toMatchObject({ status: 'completed with 1 failed row', details: '2 succeeded, 1 failed', result });
    expect(runner.getRecentSummaries()[0]).toMatchObject({ result });
  });
});
