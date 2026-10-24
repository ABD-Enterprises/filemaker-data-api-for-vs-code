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

  it('names the message type, so two failures in one panel do not look alike', async () => {
    const log = logger();
    const postError = vi.fn(async () => undefined);

    guardDispatch(async () => {
      throw new Error('The panel gave up.');
    }, {
      label: 'Record viewer request',
      type: 'loadRecord',
      logger: log,
      formatError: (error) => (error as Error).message,
      postError
    });

    await vi.waitFor(() => expect(postError).toHaveBeenCalled());
    expect(log.error).toHaveBeenCalledWith(
      'Record viewer request failed.',
      { type: 'loadRecord', error: expect.any(Error) }
    );
  });

  it('still shows the failure when the message cannot be formatted', async () => {
    const log = logger();
    const postError = vi.fn(async () => undefined);

    guardDispatch(async () => {
      throw new Error('The panel gave up.');
    }, {
      label: 'Record viewer request',
      logger: log,
      formatError: () => {
        throw new Error('The formatter is broken.');
      },
      postError
    });

    await vi.waitFor(() => expect(postError).toHaveBeenCalled());
    // The page gets the reason as plain text, not an empty panel.
    expect(postError).toHaveBeenCalledWith('The panel gave up.');
    expect(log.error).toHaveBeenCalledWith(
      'Record viewer request failed.',
      { error: expect.any(Error) }
    );
    expect(log.error).toHaveBeenCalledWith(
      'Could not format the Record viewer request failure message.',
      { error: expect.any(Error) }
    );
  });

  it('leaves no unhandled rejection when the log and the formatter both fail', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
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
        formatError: () => {
          throw new Error('The formatter is broken.');
        },
        postError
      });

      await vi.waitFor(() => expect(postError).toHaveBeenCalled());
      await new Promise((resolve) => setImmediate(resolve));
      expect(postError).toHaveBeenCalledWith('The panel gave up.');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
