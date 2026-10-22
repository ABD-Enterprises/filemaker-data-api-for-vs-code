import type { FMClient } from './fmClient';
import type {
  ConnectionProfile,
  EditRecordResult,
  FileMakerFieldMetadata,
  RecordDraftValidationResult,
  RecordPatchPreview
} from '../types/fm';
import { computeRecordPatch, validateRecordDraft } from '@fmweb/shared/dist/record-edit';

export class RecordEditService {
  public constructor(private readonly fmClient: FMClient) {}

  public validateDraft(
    draftFieldData: Record<string, unknown>,
    fields?: FileMakerFieldMetadata[]
  ): RecordDraftValidationResult {
    return validateRecordDraft(draftFieldData, fields);
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
    return computeRecordPatch(originalFieldData, draftFieldData);
  }
}
