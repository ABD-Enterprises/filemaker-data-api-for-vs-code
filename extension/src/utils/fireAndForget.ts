import type { Logger } from '../services/logger';

/** The part of the shared Logger these helpers need. */
export type FailureLogger = Pick<Logger, 'error'>;

/**
 * Writes a failure to the output channel.
 *
 * A logger that cannot write (a closed output channel) must never turn an already handled
 * failure back into an unhandled rejection, so a broken logger is swallowed here.
 *
 * The context (the message type a panel was handling, for example) is written next to the
 * failure, so two failures in the same panel do not look alike in the log.
 */
export function logFailure(
  logger: FailureLogger,
  message: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  try {
    logger.error(message, { ...context, error });
  } catch {
    // There is nothing left to report it with.
  }
}

/**
 * Runs a call that nobody waits for.
 *
 * The host starts the work and returns. A rejection there is unhandled: it is never shown to
 * the user and never written to the log, so the thing the user asked for silently does not
 * happen. This writes the failure to the output channel instead.
 */
export function runAndReport(
  label: string,
  logger: FailureLogger,
  run: () => PromiseLike<unknown>
): void {
  void Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      logFailure(logger, `${label} failed.`, error);
    });
}
