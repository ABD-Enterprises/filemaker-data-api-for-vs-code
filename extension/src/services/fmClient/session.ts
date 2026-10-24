import { createHash } from 'crypto';
import type { ConnectionProfile } from '../../types/fm';
import { FMClientError } from '../errors';

export function credentialStamp(profile: ConnectionProfile, username: string, password: string): string {
  return createHash('sha256')
    .update([profile.serverUrl, profile.database, username, password].join('\u0000'))
    .digest('hex');
}

/** A shared sign-in belongs to the connection; each waiting request owns only its own wait. */
export function waitForSession<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(new FMClientError('Request cancelled.', { kind: 'cancellation', isRetryable: false }));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    // Attach handlers even when already aborted: a later failed shared login must be observed.
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
