import { FMClientError } from '../services/errors';

export const EMPTY_FIND_ADVICE = 'Enter at least one field value to search, or use Get records to list records.';

/** An empty request (including an omit flag alone) is not a request to list records. */
export function hasFindCriteria(query: unknown): boolean {
  return Array.isArray(query) && query.length > 0 && query.every((request) =>
    request !== null && typeof request === 'object' && !Array.isArray(request) &&
    Object.entries(request).some(([field, value]) => field !== 'omit' && value !== '' && value !== undefined && value !== null)
  );
}

export function assertFindCriteria(query: unknown): void {
  if (!hasFindCriteria(query)) {
    throw new FMClientError(`Find criteria are empty. ${EMPTY_FIND_ADVICE}`, { code: '400', kind: 'validation', isRetryable: false });
  }
}
