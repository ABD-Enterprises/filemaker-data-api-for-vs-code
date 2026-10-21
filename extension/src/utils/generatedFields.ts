import type { FileMakerFieldMetadata } from '../types/fm';

/** Expand repeat keys and keep one entry per exact Data API fieldData key. */
export function fieldsForGeneration(fields: FileMakerFieldMetadata[]): FileMakerFieldMetadata[] {
  return uniqueFields(expandRepeatingFields(uniqueFields(fields)));
}

function expandRepeatingFields(fields: FileMakerFieldMetadata[]): FileMakerFieldMetadata[] {
  return fields.flatMap((field) => {
    const count = field.maxRepeat ?? field.repetitions;
    return typeof count === 'number' && Number.isInteger(count) && count > 1
      ? Array.from({ length: count }, (_, index) => ({ ...field, name: `${field.name}(${index + 1})` }))
      : [field];
  });
}

/** Data API fieldData has one key per exact field name, even for repeated layout objects. */
function uniqueFields(fields: FileMakerFieldMetadata[]): FileMakerFieldMetadata[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.name)) return false;
    seen.add(field.name);
    return true;
  });
}
