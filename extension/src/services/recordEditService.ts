import type { FMClient } from './fmClient';
import type {
  ConnectionProfile,
  EditRecordResult,
  FileMakerFieldMetadata,
  RecordDraftValidationResult,
  RecordPatchPreview
} from '../types/fm';
import { stableStringify } from '../utils/hash';

export class RecordEditService {
  public constructor(private readonly fmClient: FMClient) {}

  public validateDraft(
    draftFieldData: Record<string, unknown>,
    fields?: FileMakerFieldMetadata[]
  ): RecordDraftValidationResult {
    const errors: RecordDraftValidationResult['errors'] = [];

    for (const [name, value] of Object.entries(draftFieldData)) {
      const reason = getJsonUnsafeReason(value);
      if (reason) {
        errors.push({
          field: name,
          message: reason
        });
      }
    }

    if (fields) {
      for (const field of fields) {
        const required = isRequiredField(field);
        if (!required) {
          continue;
        }

        const value = draftFieldData[field.name];
        if (value === undefined || value === null || value === '') {
          errors.push({
            field: field.name,
            message: 'Field is required by metadata hints.'
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  public previewPatch(
    originalFieldData: Record<string, unknown>,
    draftFieldData: Record<string, unknown>
  ): RecordPatchPreview {
    const patch = this.computePatch(originalFieldData, draftFieldData);
    const changedFields = Object.keys(patch).sort((left, right) => left.localeCompare(right));

    return {
      changedFields,
      patch
    };
  }

  public async saveRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    originalFieldData: Record<string, unknown>,
    draftFieldData: Record<string, unknown>,
    options?: { modId?: string }
  ): Promise<EditRecordResult> {
    const validation = this.validateDraft(draftFieldData);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.field}: ${error.message}`).join('\n'));
    }

    const patch = this.computePatch(originalFieldData, draftFieldData);
    const changedFields = Object.keys(patch);
    if (changedFields.length === 0) {
      throw new Error('No field changes detected.');
    }

    return this.fmClient.editRecord(profile, layout, recordId, patch, undefined, options);
  }

  public computePatch(
    originalFieldData: Record<string, unknown>,
    draftFieldData: Record<string, unknown>
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set([...Object.keys(originalFieldData), ...Object.keys(draftFieldData)]);

    for (const key of keys) {
      const before = originalFieldData[key];
      const after = draftFieldData[key];

      if (!deepEqual(before, after)) {
        patch[key] = after;
      }
    }

    return patch;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  return stableStringify(left) === stableStringify(right);
}

function getJsonUnsafeReason(value: unknown): string | undefined {
  if (value === undefined) {
    return 'Undefined values are not valid JSON values.';
  }

  if (typeof value === 'bigint') {
    return 'BigInt values are not supported by JSON serialization.';
  }

  if (typeof value === 'function') {
    return 'Function values are not valid JSON values.';
  }

  if (typeof value === 'symbol') {
    return 'Symbol values are not valid JSON values.';
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const reason = getJsonUnsafeReason(entry);
      if (reason) {
        return reason;
      }
    }
  }

  if (value && typeof value === 'object') {
    for (const entryValue of Object.values(value as Record<string, unknown>)) {
      const reason = getJsonUnsafeReason(entryValue);
      if (reason) {
        return reason;
      }
    }
  }

  return undefined;
}

function isRequiredField(field: FileMakerFieldMetadata): boolean {
  if (typeof field.required === 'boolean') {
    return field.required;
  }

  if (typeof field.notEmpty === 'boolean') {
    return field.notEmpty;
  }

  if (field.validation && typeof field.validation === 'object') {
    const record = field.validation as Record<string, unknown>;
    if (typeof record.required === 'boolean') {
      return record.required;
    }

    if (typeof record.notEmpty === 'boolean') {
      return record.notEmpty;
    }
  }

  return false;
}
