import type { ValueList, ValueListItem } from '../types/fm';

/**
 * Extract value lists from a FileMaker Data API layout metadata response.
 *
 * The Data API returns value lists under `response.valueLists` as:
 * ```json
 * [{ "name": "Colors", "values": [{ "value": "Red", "displayValue": "Red" }] }]
 * ```
 */
export function extractValueLists(metadata: Record<string, unknown>): ValueList[] {
  const raw = metadata.valueLists;

  if (!Array.isArray(raw)) {
    return [];
  }

  const result: ValueList[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : undefined;

    if (!name) {
      continue;
    }

    const values = extractValueListItems(record.values);
    result.push({ name, values });
  }

  return result;
}

function extractValueListItems(raw: unknown): ValueListItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const items: ValueListItem[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const value = typeof record.value === 'string' ? record.value : String(record.value ?? '');
    const displayValue = typeof record.displayValue === 'string' ? record.displayValue : value;

    items.push({ value, displayValue });
  }

  return items;
}
