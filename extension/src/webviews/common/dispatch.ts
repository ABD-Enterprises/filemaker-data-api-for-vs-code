import { logFailure, type FailureLogger } from '../../utils/fireAndForget';

export interface DispatchOptions {
  /** What the panel was doing, e.g. 'Record viewer request'. Used in the log line. */
  readonly label: string;
  readonly logger: FailureLogger;
  /** Turns a failure into the text the page shows. */
  readonly formatError: (error: unknown) => string;
  /** Posts the failure to the page, with the panel's own error message. */
  readonly postError: (message: string) => Promise<void>;
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
      logFailure(options.logger, `${options.label} failed.`, error);
      void Promise.resolve()
        .then(() => options.postError(options.formatError(error)))
        .catch((postFailure: unknown) => {
          logFailure(options.logger, `Could not post the ${options.label} failure to the page.`, postFailure);
        });
    });
}
