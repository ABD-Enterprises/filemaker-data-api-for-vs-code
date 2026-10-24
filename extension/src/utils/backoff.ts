export interface BackoffPolicy {
  maxRetries: number;
  initialMs: number;
  maxMs: number;
  multiplier: number;
  /** Random factor between 0 and 1 for jitter; default 0.25 (±25%). */
  jitter?: number;
}

/**
 * Compute the delay (in ms) to wait before retry attempt N (0-indexed).
 * Returns capped exponential backoff with optional jitter.
 *
 * Pure helper — does not sleep. Caller is responsible for the wait.
 */
export function computeBackoffDelayMs(
  attemptIndex: number,
  policy: BackoffPolicy,
  random: () => number = Math.random
): number {
  const safeAttempt = Math.max(0, attemptIndex);
  const base = policy.initialMs * Math.pow(policy.multiplier, safeAttempt);
  const capped = Math.min(policy.maxMs, base);
  const jitterFactor = policy.jitter ?? 0.25;
  if (jitterFactor <= 0) {
    return Math.max(0, Math.round(capped));
  }
  // Symmetric jitter: ±jitterFactor around capped.
  const delta = capped * jitterFactor * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + delta));
}

export interface RetryHooks {
  /** Decide whether to retry the given error. Default: always retry. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each delay; useful for status-bar countdowns. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Sleep implementation; defaulted to setTimeout. Tests inject a synchronous variant. */
  sleep?: (ms: number) => Promise<void>;
  /** Random source; defaults to Math.random. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: BackoffPolicy,
  hooks?: RetryHooks
): Promise<T> {
  const sleep = hooks?.sleep ?? defaultSleep;
  const random = hooks?.random ?? Math.random;
  const shouldRetry = hooks?.shouldRetry ?? (() => true);

  const totalAttempts = Math.max(1, policy.maxRetries + 1);
  let lastError: unknown;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === totalAttempts - 1 || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, policy, random);
      hooks?.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  // Unreachable: loop either returns or throws on the last attempt.
  throw lastError as Error;
}
