import { describe, expect, it, vi } from 'vitest';

import { guardDispatch } from '../../../src/webviews/common/dispatch';

/**
 * The host hands a panel a message and returns; the handler runs on its own. A rejection there is
 * unhandled, so the page waits for an answer that never comes and shows nothing at all. The guard
 * is what turns that silence into a message on the page and a line in the output channel.
 */

function logger() {
  return { error: vi.fn() };
}

describe('The webview dispatch guard', () => {
  it('posts a failed request to the page and writes it to the log', async () => {
    const log = logger();
    const postError = vi.fn(async () => undefined);

    guardDispatch(async () => {
      throw new Error('The panel gave up.');
    }, {
      label: 'Record viewer request',
      logger: log,
      formatError: (error) => (error as Error).message,
      postError
    });

    await vi.waitFor(() => expect(postError).toHaveBeenCalledWith('The panel gave up.'));
    expect(log.error).toHaveBeenCalledWith('Record viewer request failed.', { error: expect.any(Error) });
  });

  it('catches a failure thrown before the request even starts', async () => {
    const log = logger();
    const postError = vi.fn(async () => undefined);

    guardDispatch(() => {
      throw new Error('The panel could not start.');
    }, {
      label: 'Record viewer request',
      logger: log,
      formatError: (error) => (error as Error).message,
      postError
    });

    await vi.waitFor(() => expect(postError).toHaveBeenCalledWith('The panel could not start.'));
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('still shows the failure when the log cannot be written', async () => {
    const log = {
      error: vi.fn(() => {
        throw new Error('The output channel is closed.');
      })
    };
    const postError = vi.fn(async () => undefined);

    guardDispatch(async () => {
      throw new Error('The panel gave up.');
    }, {
      label: 'Record viewer request',
      logger: log,
      formatError: (error) => (error as Error).message,
      postError
    });

    await vi.waitFor(() => expect(postError).toHaveBeenCalledWith('The panel gave up.'));
  });

  it('writes the failure down when it cannot be posted to the page', async () => {
    const log = logger();
    const postError = vi.fn(async () => {
      throw new Error('The page is gone.');
    });

    guardDispatch(async () => {
      throw new Error('The panel gave up.');
    }, {
      label: 'Record viewer request',
      logger: log,
      formatError: (error) => (error as Error).message,
      postError
    });

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(2));
    expect(log.error).toHaveBeenLastCalledWith(
      'Could not post the Record viewer request failure to the page.',
      { error: expect.any(Error) }
    );
  });

  it('leaves a successful request alone', async () => {
    const log = logger();
    const postError = vi.fn(async () => undefined);

    guardDispatch(async () => undefined, {
      label: 'Record viewer request',
      logger: log,
      formatError: (error) => String(error),
      postError
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(postError).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
