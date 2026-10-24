import { FMClientError } from '../services/errors';

/** Reject a missing or blank name without changing any of its characters. */
export function assertNameProvided(
  name: string | undefined,
  message: string,
  error: (message: string) => Error = (message) => new FMClientError(message)
): asserts name is string {
  if (name === undefined || /^\s*$/.test(name)) {
    throw error(message);
  }
}

/**
 * `.` and `..` are not usable as one path segment of a request: encodeURIComponent leaves dots alone, and
 * the URL parser then resolves the segment away (`.../layouts/L/script/..` becomes `.../layouts/L/`, a
 * different request that reports success). A layout, script or field called `.` or `..` is refused before
 * anything is sent.
 */
export function isDotSegment(name: string): boolean {
  return name === '.' || name === '..';
}

/** The message for a layout, script or field name that is `.` or `..`. */
export function dotSegmentMessage(kind: string, name: string): string {
  return `The ${kind} name "${name}" cannot be used in a request (a web address treats it as a folder reference). Rename it in FileMaker.`;
}

/** Reject before authentication or a request; preserve every usable name byte for byte. */
export function assertUsableUrlName(name: string, kind: string, error?: (message: string) => Error): void {
  if (isDotSegment(name)) {
    const message = dotSegmentMessage(kind, name);
    throw error ? error(message) : new FMClientError(message, {
      code: 'NAME_NOT_USABLE_IN_URL', kind: 'validation', isRetryable: false
    });
  }
}
