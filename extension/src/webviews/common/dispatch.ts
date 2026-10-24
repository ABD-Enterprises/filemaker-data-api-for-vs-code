import { logFailure, type FailureLogger } from '../../utils/fireAndForget';
import { getStringField, toRecord } from './messageValidation';

export interface DispatchOptions {
  /** What the panel was doing, e.g. 'Record viewer request'. Used in the log line. */
  readonly label: string;
  /** The message the panel was handling, e.g. 'loadRecord'. Tells two failures in one panel apart. */
  readonly type?: string;
  readonly logger: FailureLogger;
  /** Turns a failure into the text the page shows. */
  readonly formatError: (error: unknown) => string;
  /** Posts the failure to the page, with the panel's own error message. */
  readonly postError: (message: string) => Promise<void>;
}

/**
 * The type of the message the page sent, e.g. 'loadRecord'.
 *
 * A panel handles many requests, and two of them can fail the same way. The log line names
 * the message, so the reader can tell which request the failure belongs to.
 */
export function requestType(message: unknown): string | undefined {
  const record = toRecord(message);
  return record ? getStringField(record, 'type', { maxLength: 64 }) : undefined;
}

/**
 * Runs a webview entry point that nobody awaits.
 *
 * The host hands the panel a message and returns; the handler then runs on its own. A rejection
 * there is unhandled, so the page would wait for an answer that never comes and show nothing at
 * all — a frozen panel with no error. This logs the failure and posts it back to the page, the
 * same way the per-action handlers report theirs.
 */
export function guardDispatch(run: () => PromiseLike<void>, options: DispatchOptions): void {
  void Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      logFailure(
        options.logger,
        `${options.label} failed.`,
        error,
        options.type ? { type: options.type } : undefined
      );
      void Promise.resolve()
        .then(() => options.postError(failureMessage(options, error)))
        .catch((postFailure: unknown) => {
          logFailure(options.logger, `Could not post the ${options.label} failure to the page.`, postFailure);
        });
    });
}

/**
 * The text the page shows for a failure.
 *
 * A formatter that throws must not swallow the failure: the page would sit there with no
 * error at all, which is the very thing this guard exists to prevent. The reason the
 * formatter failed is written to the log and a plain fallback is posted instead.
 */
function failureMessage(options: DispatchOptions, error: unknown): string {
  try {
    const message = options.formatError(error);
    return typeof message === 'string' ? message : fallbackMessage(error);
  } catch (formatFailure: unknown) {
    logFailure(options.logger, `Could not format the ${options.label} failure message.`, formatFailure);
    return fallbackMessage(error);
  }
}

/** The last resort: the reason as plain text, so the page shows something. */
function fallbackMessage(error: unknown): string {
  try {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error);
  } catch {
    return 'Something went wrong.';
  }
}
