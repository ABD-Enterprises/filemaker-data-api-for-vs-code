import type { FileMakerRecord } from '../types/fm';

/**
 * Extract field data from a record suitable for creating a duplicate.
 * Strips recordId, modId, and portal data — only copies fieldData.
 */
export function extractDuplicateFieldData(
  record: FileMakerRecord
): Record<string, unknown> {
  const fieldData = { ...record.fieldData };

  // Remove any auto-entered or system fields that shouldn't be duplicated.
  // Callers can customize further before passing to createRecord.
  return fieldData;
}

/**
 * Check if a field should be excluded from duplication.
 * Typically auto-enter serial numbers, creation timestamps, etc.
 * This is a heuristic — callers should review the result.
 */
export function isLikelyAutoEnterField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();

  return (
    lower.includes('__pk') ||
    lower.includes('_pk_') ||
    lower.includes('primarykey') ||
    lower.includes('primary_key') ||
    lower.includes('serialnumber') ||
    lower.includes('serial_number') ||
    lower.includes('createdby') ||
    lower.includes('created_by') ||
    lower.includes('createdon') ||
    lower.includes('created_on') ||
    lower.includes('creationtimestamp') ||
    lower.includes('creation_timestamp') ||
    lower.includes('recordid') ||
    lower.includes('record_id') ||
    lower.endsWith('_id') ||
    lower.endsWith('id') && lower.length <= 4
  );
}

/**
 * Prepare field data for duplication by optionally excluding auto-enter fields.
 */
export function prepareDuplicateFieldData(
  record: FileMakerRecord,
  excludeAutoEnter = true
): Record<string, unknown> {
  const fieldData = extractDuplicateFieldData(record);

  if (!excludeAutoEnter) {
    return fieldData;
  }

  const filtered: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const [key, value] of Object.entries(fieldData)) {
    if (!isLikelyAutoEnterField(key)) {
      filtered[key] = value;
    }
  }

  return filtered;
}
