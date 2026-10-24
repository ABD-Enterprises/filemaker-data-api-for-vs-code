/**
 * Extract field names from a FileMaker Data API layout metadata payload.
 *
 * The Data API returns a metadata document under `response.fieldMetaData`
 * (regular fields) and `response.portalMetaData[<table>]` (related fields).
 * Some servers/proxies return the same arrays at the top level. This
 * helper handles both shapes defensively and is exported for unit tests.
 */
export function extractLayoutFieldNames(metadata: unknown): string[] {
  const seen = new Set<string>();

  if (!metadata || typeof metadata !== 'object') {
    return [];
  }

  const root = metadata as Record<string, unknown>;
  const responseField = root.response;
  const responseRoot =
    responseField && typeof responseField === 'object' ? (responseField as Record<string, unknown>) : root;

  collectFromArray(responseRoot.fieldMetaData, seen);
  collectFromArray(root.fieldMetaData, seen);

  const portalRoot = responseRoot.portalMetaData ?? root.portalMetaData;
  if (portalRoot && typeof portalRoot === 'object' && !Array.isArray(portalRoot)) {
    for (const value of Object.values(portalRoot as Record<string, unknown>)) {
      collectFromArray(value, seen);
    }
  }

  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

function collectFromArray(value: unknown, sink: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (item && typeof item === 'object' && 'name' in item) {
      const name = (item as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0) {
        sink.add(name);
      }
    }
  }
}
