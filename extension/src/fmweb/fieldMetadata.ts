import type { StandardFieldMetadata } from '@fmweb/shared/dist/field-standards';
import { extractValueLists } from '../utils/valueListParser';
import { extractFieldsFromMetadata } from '../services/schemaService';

export interface DesignerLayoutMetadata {
  layoutName: string;
  fields: StandardFieldMetadata[];
  portals: Array<{ name: string; fields: string[] }>;
}

/** Preserve metadata order and exact identifiers; never alphabetize or normalize names. */
export function designerLayoutMetadata(layoutName: string, metadata: Record<string, unknown>): DesignerLayoutMetadata {
  const response = metadata.response && typeof metadata.response === 'object' ? metadata.response as Record<string, unknown> : {};
  const valueLists = extractValueLists({ valueLists: metadata.valueLists ?? response.valueLists });
  const fields = extractFieldsFromMetadata(metadata).filter((field) => field.name.trim().length > 0).map((field) => ({
    name: field.name,
    type: field.result ?? field.type,
    displayType: typeof field.displayType === 'string' ? field.displayType : undefined,
    multiline: field.multiline === true,
    optionCount: Array.isArray(field.values) ? field.values.length
      : valueLists.find((list) => list.name === field.valueList)?.values.length
        ?? (typeof field.optionCount === 'number' ? field.optionCount : undefined)
  }));
  const rawPortals = metadata.portalMetaData ?? response.portalMetaData;
  const portals = rawPortals && typeof rawPortals === 'object' && !Array.isArray(rawPortals)
    ? Object.entries(rawPortals).map(([name, entries]) => ({
        name,
        fields: Array.isArray(entries) ? extractFieldsFromMetadata({ fields: entries }).map((field) => field.name) : []
      })) : [];
  return { layoutName, fields, portals };
}

/** Source-less layouts have a cross-layout palette. Bound its compact descriptors, not identifiers. */
export function boundedDesignerFields(layouts: DesignerLayoutMetadata[], maxBytes = 256 * 1024): StandardFieldMetadata[] {
  const fields: StandardFieldMetadata[] = [];
  const seen = new Set<string>();
  let bytes = 2;
  for (const layout of layouts) for (const field of layout.fields) {
    if (seen.has(field.name)) continue;
    const size = Buffer.byteLength(JSON.stringify(field), 'utf8') + (fields.length ? 1 : 0);
    if (bytes + size > maxBytes) continue;
    bytes += size;
    seen.add(field.name);
    fields.push(field);
  }
  return fields;
}
