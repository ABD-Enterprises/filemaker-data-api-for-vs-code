import * as path from 'path';

import { hasInvisiblePathCharacter } from './pathConfinement';

/** The folder text with slashes tidied, or undefined when it cannot be used (empty, absolute, containing "..", or containing invisible characters). */
export function usableRelativeDir(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (hasInvisiblePathCharacter(value) || !normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}
