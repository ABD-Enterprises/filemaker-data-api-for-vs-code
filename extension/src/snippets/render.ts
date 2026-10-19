import { randomBytes } from 'crypto';

import { encodeComponent, safeJson } from './escape';
import { Placeholder, type RequestSpec } from './model';

/** How a format shows the values the reader fills in. */
export interface PlaceholderStyle {
  /** The text that replaces a `Placeholder` (without quotes), for example `<modId>` or `{{modId}}`. */
  modId: string;
}

export function queryText(spec: RequestSpec, style: PlaceholderStyle): string {
  return spec.query
    .map(([key, value]) => {
      const text = value instanceof Placeholder ? style.modId : encodeComponent(value);
      return `${encodeComponent(key)}=${text}`;
    })
    .join('&');
}

/** `path` followed by `?query` when there is one. */
export function pathAndQuery(spec: RequestSpec, style: PlaceholderStyle): string {
  const query = queryText(spec, style);
  return query.length > 0 ? `${spec.path}?${query}` : spec.path;
}

function withSentinels(value: unknown, sentinels: Map<string, string>, nonce: string): unknown {
  if (value instanceof Placeholder) {
    const sentinel = `fm-placeholder-${nonce}-${value.name}`;
    sentinels.set(sentinel, value.name);
    return sentinel;
  }
  if (Array.isArray(value)) {
    return value.map((item) => withSentinels(item, sentinels, nonce));
  }
  if (value && typeof value === 'object') {
    // Object.fromEntries defines own properties, so a key called __proto__ stays a key.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, withSentinels(item, sentinels, nonce)])
    );
  }
  return value;
}

/**
 * The request body as safe JSON text. `Placeholder` values become `placeholderLiteral(name)`
 * (a complete JSON value, for example `"<modId>"`), written after the escaping so that nothing
 * the database sent can look like a placeholder: the marker is a random per-call string.
 */
export function bodyJson(
  value: unknown,
  options: {
    space?: number;
    neutralizeTemplates?: boolean;
    placeholderLiteral: (name: string) => string;
  }
): string {
  const nonce = randomBytes(12).toString('hex');
  const sentinels = new Map<string, string>();
  const marked = withSentinels(value, sentinels, nonce);
  let text = safeJson(marked, options);
  for (const [sentinel, name] of sentinels) {
    text = text.split(`"${sentinel}"`).join(options.placeholderLiteral(name));
  }
  return text;
}

/** True when `__proto__` is a key somewhere in the JSON text (a JavaScript object literal would turn it into a prototype). */
export function hasProtoKey(jsonText: string): boolean {
  return /"__proto__"\s*:/.test(jsonText);
}

/** Splits text into lines and prefixes each (for comment blocks). `lines` must already be single lines. */
export function commentBlock(prefix: string, lines: readonly string[]): string[] {
  return lines.map((line) => `${prefix}${line}`);
}

function containsPlaceholder(value: unknown): boolean {
  if (value instanceof Placeholder) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsPlaceholder);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsPlaceholder);
  }
  return false;
}

/** True when the request has a modId for the reader to fill in (in the query or the body). */
export function usesModId(spec: RequestSpec): boolean {
  return (
    spec.query.some(([, value]) => value instanceof Placeholder) ||
    (spec.body?.kind === 'json' && containsPlaceholder(spec.body.value))
  );
}
