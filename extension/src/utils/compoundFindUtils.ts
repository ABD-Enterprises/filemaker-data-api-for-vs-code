/**
 * Utilities for compound find requests in the FileMaker Data API.
 *
 * A compound find uses multiple request objects, each optionally with an `omit` flag.
 * The Data API combines them with OR logic, and `omit: true` excludes matching records.
 */

export interface FindRequestRow {
  criteria: Record<string, string>;
  omit: boolean;
}

/**
 * Build a compound find query array from structured request rows.
 *
 * Each row becomes a request object in the query array.
 * Rows with `omit: true` get an `"omit": "true"` field added.
 *
 * Example output:
 * ```json
 * [
 *   { "Name": "Smith" },
 *   { "City": "Portland", "omit": "true" }
 * ]
 * ```
 */
export function buildCompoundFindQuery(
  rows: FindRequestRow[]
): Array<Record<string, string>> {
  return rows
    .filter((row) => Object.keys(row.criteria).length > 0)
    .map((row) => {
      const request = { ...row.criteria };

      if (row.omit) {
        request.omit = 'true';
      }

      return request;
    });
}

/**
 * Parse a Data API find query array back into structured request rows.
 */
export function parseCompoundFindQuery(
  query: Array<Record<string, unknown>>
): FindRequestRow[] {
  return query.map((request) => {
    const omit = request.omit === 'true' || request.omit === true;

    const criteria: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(request)) {
      if (key !== 'omit' && typeof value === 'string') {
        criteria[key] = value;
      }
    }

    return { criteria, omit };
  });
}

/**
 * Validate a compound find query — at least one non-omit request required.
 */
export function validateCompoundFind(rows: FindRequestRow[]): string | undefined {
  if (rows.length === 0) {
    return 'At least one find request is required.';
  }

  const nonOmitRows = rows.filter((r) => !r.omit && Object.keys(r.criteria).length > 0);
  if (nonOmitRows.length === 0) {
    return 'At least one non-omit find request with criteria is required.';
  }

  return undefined;
}
