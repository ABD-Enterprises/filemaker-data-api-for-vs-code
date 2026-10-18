import * as path from 'path';

/** The folder text with slashes tidied, or undefined when it cannot be used (empty, absolute, or containing ".."). */
export function usableRelativeDir(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}
