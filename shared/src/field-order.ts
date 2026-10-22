export interface FieldOrderMetadata {
  fieldMetaData?: ReadonlyArray<{ name: string }>;
  fields?: ReadonlyArray<{ name: string }>;
}

/** Order only returned fields: unavailable fields must never appear just because metadata names them. */
export function orderFields(layoutMetadata: FieldOrderMetadata | undefined, fieldData: Record<string, unknown>): string[] {
  const keys = Object.keys(fieldData);
  const base = (name: string): string => name.replace(/\(\d+\)$/, '');
  const order = new Map<string, number>();
  for (const field of layoutMetadata?.fieldMetaData ?? layoutMetadata?.fields ?? []) {
    const name = base(field.name);
    if (!order.has(name)) order.set(name, order.size);
  }
  return keys.slice().sort((a, b) => {
    const aOrder = order.get(base(a));
    const bOrder = order.get(base(b));
    if (aOrder === undefined && bOrder === undefined) return 0;
    if (aOrder === undefined) return 1;
    if (bOrder === undefined) return -1;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return Number(/\((\d+)\)$/.exec(a)?.[1] ?? 0) - Number(/\((\d+)\)$/.exec(b)?.[1] ?? 0);
  });
}
