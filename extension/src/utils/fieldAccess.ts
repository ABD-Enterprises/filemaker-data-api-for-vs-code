import type { FileMakerFieldMetadata } from '../types/fm';

/** Metadata uses the base name while record data uses Name(n) for repetitions. */
export function metadataForField(fields: FileMakerFieldMetadata[], name: string): FileMakerFieldMetadata | undefined {
  return fields.find((field) => field.name === name)
    ?? fields.find((field) => field.name === name.replace(/\(\d+\)$/, ''));
}

export function fieldType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function readOnlyFieldKind(field?: FileMakerFieldMetadata): string | undefined {
  const type = fieldType(field?.type);
  if (type === 'calculation' || type === 'summary') return type;
  if (fieldType(field?.result) === 'container' || type === 'container') return 'container';
  return undefined;
}

export function editableFieldData(values: Record<string, unknown>, fields: FileMakerFieldMetadata[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => !readOnlyFieldKind(metadataForField(fields, name))));
}
