import type { StandardFieldMetadata } from '@fmweb/shared/dist/field-standards';
import { extractFieldsFromMetadata } from '../services/schemaService';

export interface DesignerLayoutMetadata {
  layoutName: string;
  fields: StandardFieldMetadata[];
  portals: Array<{ name: string; fields: string[] }>;
}

/** Preserve metadata order and exact identifiers; never alphabetize or normalize names. */
export function designerLayoutMetadata(layoutName: string, metadata: Record<string, unknown>): DesignerLayoutMetadata {
  const fields = extractFieldsFromMetadata(metadata).filter((field) => field.name.trim().length > 0).map((field) => ({
    name: field.name,
    type: field.result ?? field.type,
    displayType: typeof field.displayType === 'string' ? field.displayType : undefined,
    multiline: field.multiline === true,
    optionCount: Array.isArray(field.values) ? field.values.length : typeof field.optionCount === 'number' ? field.optionCount : undefined
  }));
  const response = metadata.response && typeof metadata.response === 'object' ? metadata.response as Record<string, unknown> : {};
  const rawPortals = metadata.portalMetaData ?? response.portalMetaData;
  const portals = rawPortals && typeof rawPortals === 'object' && !Array.isArray(rawPortals)
    ? Object.entries(rawPortals).map(([name, entries]) => ({
        name,
        fields: Array.isArray(entries) ? extractFieldsFromMetadata({ fields: entries }).map((field) => field.name) : []
      })) : [];
  return { layoutName, fields, portals };
}
