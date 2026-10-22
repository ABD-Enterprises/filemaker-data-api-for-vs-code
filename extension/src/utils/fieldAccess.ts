import { readOnlyFieldKind } from '@fmweb/shared/dist/record-edit';
import type { FileMakerFieldMetadata } from '../types/fm';

/** Metadata uses the base name while record data uses Name(n) for repetitions. */
export function metadataForField(fields: FileMakerFieldMetadata[], name: string): FileMakerFieldMetadata | undefined {
  return fields.find((field) => field.name === name)
    ?? fields.find((field) => field.name === name.replace(/\(\d+\)$/, ''));
}

export { fieldType, readOnlyFieldKind } from '@fmweb/shared/dist/record-edit';

export function editableFieldData(values: Record<string, unknown>, fields: FileMakerFieldMetadata[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => !readOnlyFieldKind(metadataForField(fields, name))));
}
