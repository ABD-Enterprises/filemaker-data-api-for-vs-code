import type { FileMakerRecord, PortalDataInfo } from '../types/fm';

/** Metadata is ordered separately from fields, including integer-looking field names. */
export function exportColumns(names: string[]): [string, string] {
  if (!names.some((name) => /^(recordId|modId)$/i.test(name))) return ['recordId', 'modId'];
  let prefix = '__';
  const lower = new Set(names.map((name) => name.toLowerCase()));
  while (lower.has(`${prefix}recordid`) || lower.has(`${prefix}modid`)) prefix += '_';
  return [`${prefix}recordId`, `${prefix}modId`];
}
export function portalNotes(record: FileMakerRecord): string {
  return (record.portalDataInfo ?? []).flatMap((info: PortalDataInfo) => {
    const name = info.portalObjectName ?? info.table;
    return name && info.returnedCount < info.foundCount
      ? [`${name}: showing ${info.returnedCount} of ${info.foundCount}`] : [];
  }).join('; ');
}
export function exportRow(record: FileMakerRecord, meta: [string, string], noteColumn?: string): Map<string, unknown> {
  const row = new Map<string, unknown>([[meta[0], record.recordId], [meta[1], record.modId]]);
  for (const [name, value] of Object.entries(record.fieldData)) {
    if (meta.some((key) => key.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Export column collision for field "${name}". Export again with layout metadata available.`);
    }
    row.set(name, value);
  }
  if (noteColumn) row.set(noteColumn, portalNotes(record));
  return row;
}
