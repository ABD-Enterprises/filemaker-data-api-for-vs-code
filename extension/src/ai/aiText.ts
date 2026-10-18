import { filterName } from '../services/aiContextRenderer';

/** Text that replaces a value the policy removed or could not show. */
export const HIDDEN_MARKER = '[hidden]';
export const REDACTION_MARKER = '***';
export const OMITTED_NAME = '[name omitted]';

/**
 * Makes untrusted text safe to put on one line of a dialog or log: capped to `max`
 * characters, JSON-escaped (quotes, backslashes, newlines and other control characters), and
 * with the characters JSON leaves alone but that can reorder or split text (U+2028/9, bidi and
 * other format characters) written as \uXXXX. A cut is marked outside the quotes.
 */
export function displayText(value: unknown, max = 80): string {
  const text = typeof value === 'string' ? value : String(value);
  const characters = Array.from(text);
  const kept = characters.slice(0, max).join('');
  const escaped = JSON.stringify(kept).replace(
    /[\p{C}\u2028\u2029]/gu,
    (character) => `\\u${(character.codePointAt(0) as number).toString(16).padStart(4, '0')}`
  );
  const cut = characters.length - Math.min(characters.length, max);
  return cut > 0 ? `${escaped}…(+${cut} more characters)` : escaped;
}

/** A name that is safe to show the model and send back unchanged (layouts and scripts: the Phase 1 allowlist). */
export function safeNameOrUndefined(name: unknown): string | undefined {
  const result = filterName(name);
  return result.replaced ? undefined : result.text;
}

const FIELD_NAME_MAX = 128;

/**
 * A field name the model must be able to send back exactly (ADR-0004 rule 6): kept as it is
 * unless it is long or contains control, format or separator characters, which hide or split text.
 */
export function exactFieldNameOrUndefined(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.trim().length === 0 || Array.from(name).length > FIELD_NAME_MAX) {
    return undefined;
  }
  return /[\p{C}\u2028\u2029]/u.test(name) ? undefined : name;
}

function normalizeFieldName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** The two forms a field name is compared by: with its `Table::` prefix, and without it. */
function nameForms(name: string): string[] {
  const full = normalizeFieldName(name);
  const index = full.lastIndexOf('::');
  return index >= 0 ? [full, full.slice(index + 2).trim()] : [full];
}

/**
 * Best-effort hidden-field filter (ADR-0004 rule 8). The Data API gives no base table for a
 * field, so an entry hides every field with the same normalized name, with or without a
 * `Table::` prefix, on every layout. It does not stop disclosure through a calculation,
 * summary field or script on another layout; a restricted FileMaker account does.
 */
export class HiddenFields {
  private readonly forms: Set<string>;

  public constructor(entries: readonly string[]) {
    this.forms = new Set(entries.flatMap((entry) => nameForms(entry)).filter((form) => form.length > 0));
  }

  public isHidden(fieldName: string): boolean {
    return nameForms(fieldName).some((form) => this.forms.has(form));
  }

  /** A copy without the hidden keys (also used for portal rows). */
  public stripKeys<T>(record: Record<string, T>): Record<string, T> {
    return Object.fromEntries(Object.entries(record).filter(([key]) => !this.isHidden(key)));
  }
}
