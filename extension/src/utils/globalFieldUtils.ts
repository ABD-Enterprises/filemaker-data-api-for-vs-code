/**
 * Utilities for global field handling in the FileMaker Data API.
 *
 * Global fields can be set via the `script.param` or `globalFields` body parameter
 * on find/get/create/edit endpoints.
 */

export interface GlobalFieldEntry {
  fieldName: string;
  value: string;
}

/**
 * Build the `globalFields` request body parameter from an array of field entries.
 * The Data API expects: `{ "globalFields": { "FieldName": "value" } }`
 */
export function buildGlobalFieldsPayload(
  entries: GlobalFieldEntry[]
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const entry of entries) {
    // Exactly as given: a leading or trailing space can be part of a field name. Only a blank name is skipped.
    const name = entry.fieldName;
    if (name.trim().length > 0) {
      result[name] = entry.value;
    }
  }

  return result;
}

/**
 * Parse a global fields object from a Data API request body back into entries.
 */
export function parseGlobalFieldsPayload(
  payload: Record<string, unknown>
): GlobalFieldEntry[] {
  const globals = payload.globalFields;

  if (!globals || typeof globals !== 'object' || Array.isArray(globals)) {
    return [];
  }

  return Object.entries(globals as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')
    .map(([fieldName, value]) => ({ fieldName, value: value as string }));
}

/**
 * Validate that a global field name follows FileMaker naming conventions.
 * Global fields are typically prefixed with the table occurrence name.
 */
export function isValidGlobalFieldName(name: string): boolean {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return false;
  }

  // Must not contain control characters or null bytes
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f) {
      return false;
    }
  }

  return true;
}
