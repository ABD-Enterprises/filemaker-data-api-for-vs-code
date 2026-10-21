/** Real FileMaker Server writes accept NUL but silently discard the following text. */
export const NUL_TEXT_WARNING = 'FileMaker keeps only the text before this character and drops the rest.';

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
