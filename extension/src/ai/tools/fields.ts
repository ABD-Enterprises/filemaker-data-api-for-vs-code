import { containsNulText, NUL_TEXT_WARNING } from '../../utils/nulText';
import { MAX_FIELDS_PER_WRITE, MAX_WRITE_VALUE_CHARS } from '../aiToolDefinitions';
import { PLACEHOLDER_MARKERS, baseFieldName, displayText, exactFieldNameOrUndefined } from '../aiText';
import { AiToolError } from './errors';
import type { LayoutFields } from './types';

/** Names `omit` and `__proto__` collide with the find body and with object keys: not usable. */
export function usableFieldName(name: unknown): string | undefined {
  const exact = exactFieldNameOrUndefined(name);
  if (exact === undefined) {
    return undefined;
  }
  const base = baseFieldName(exact).toLowerCase();
  return base === 'omit' || base === '__proto__' ? undefined : exact;
}

/** A field the layout has and policy shows. Unknown and hidden give the same answer. */
export function knownField(fields: LayoutFields, name: string): string {
  if (!fields.names.has(name)) {
    throw new AiToolError(`Unknown or unavailable field ${displayText(name, 64)} on this layout. Use names from fm_describe_layout.`);
  }
  return name;
}

export function validateWriteFields(fields: LayoutFields, given: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(given);
  if (entries.length === 0) {
    throw new AiToolError('At least one field is required.');
  }
  if (entries.length > MAX_FIELDS_PER_WRITE) {
    throw new AiToolError(`At most ${MAX_FIELDS_PER_WRITE} fields per write: the approval dialog shows every field.`);
  }
  return entries.map(([name, value]) => {
    if (name.includes('::')) {
      throw new AiToolError('Related-record fields (Table::Field) cannot be written.');
    }
    const known = knownField(fields, name);
    const readOnly = fields.readOnly.get(known);
    if (readOnly) {
      throw new AiToolError(`${readOnly[0]!.toUpperCase()}${readOnly.slice(1)} fields cannot be written by AI tools.`);
    }
    if (Array.from(value).length > MAX_WRITE_VALUE_CHARS) {
      throw new AiToolError(`A value may have at most ${MAX_WRITE_VALUE_CHARS} characters: the approval dialog shows each value in full.`);
    }
    if (PLACEHOLDER_MARKERS.some((marker) => value.includes(marker))) {
      throw new AiToolError(`A value may not contain ${PLACEHOLDER_MARKERS.join(', ')}; those mark text the tools hid, redacted or replaced.`);
    }
    if (containsNulText(value)) {
      throw new AiToolError(`NUL character (U+0000) in field ${name}. ${NUL_TEXT_WARNING} Remove the character and try again.`);
    }
    return [known, value];
  });
}
