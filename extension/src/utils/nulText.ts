import { FMClientError } from '../services/errors';

/** Observed on the FileMaker server we tested; refuse NUL to prevent possible data loss. */
export const NUL_TEXT_WARNING = 'On the FileMaker server we tested, FileMaker kept only the text before this character and dropped the rest.';

export function containsNulText(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\0');
  if (Array.isArray(value)) return value.some(containsNulText);
  if (value && typeof value === 'object') return Object.values(value).some(containsNulText);
  return false;
}

export function nulTextFields(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter((name) => containsNulText(fields[name]));
}

/** Remove only U+0000 from values, preserving all field names and all following text. */
export function removeNulText(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\0', '');
  if (Array.isArray(value)) return value.map(removeNulText);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, removeNulText(item)]));
  }
  return value;
}

export function nulTextError(fields: Record<string, unknown>): string | undefined {
  const names = nulTextFields(fields);
  return names.length ? `NUL character (U+0000) in field(s): ${names.join(', ')}. ${NUL_TEXT_WARNING} Nothing in this row was written. Remove the character from the source and try again.` : undefined;
}

/** Refuse unsafe writes for callers that cannot ask the user to remove NUL. */
export function assertNoNulText(fields: Record<string, unknown>): void {
  const reason = nulTextError(fields);
  if (reason) throw new FMClientError(reason, { status: 400 });
}
