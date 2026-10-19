import { jsString, safeJson, shellQuote } from '../snippets/escape';

/**
 * Copies an arbitrary request as curl or fetch(). Kept for callers that already hold a finished
 * request; the Data API operations go through `src/snippets` (`generateSnippet`), which shares
 * these escapes.
 */
export interface SnippetRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface SnippetOptions {
  includeAuthHeader?: boolean;
}

function isAuthorizationHeader(headerName: string): boolean {
  return headerName.toLowerCase() === 'authorization';
}

function normalizeHeaderValue(name: string, value: string, includeAuthHeader: boolean): string {
  if (isAuthorizationHeader(name) && !includeAuthHeader) {
    return 'Bearer <REDACTED>';
  }

  return value;
}

function sanitizeHeaders(
  headers: Record<string, string> | undefined,
  includeAuthHeader: boolean
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    result[name] = normalizeHeaderValue(name, value, includeAuthHeader);
  }

  return result;
}

function serializeBody(body: unknown): string | undefined {
  if (body === undefined) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

export function generateCurlSnippet(request: SnippetRequest, options?: SnippetOptions): string {
  const includeAuthHeader = options?.includeAuthHeader ?? false;
  const headers = sanitizeHeaders(request.headers, includeAuthHeader);

  const parts: string[] = ['curl'];

  parts.push('-X', shellQuote(request.method.toUpperCase()));
  parts.push(shellQuote(request.url));

  for (const [name, value] of Object.entries(headers)) {
    parts.push('-H', shellQuote(`${name}: ${value}`));
  }

  const body = serializeBody(request.body);
  if (body !== undefined) {
    parts.push('--data-raw', shellQuote(body));
  }

  return parts.join(' ');
}

export function generateFetchSnippet(request: SnippetRequest, options?: SnippetOptions): string {
  const includeAuthHeader = options?.includeAuthHeader ?? false;
  const headers = sanitizeHeaders(request.headers, includeAuthHeader);

  const body = serializeBody(request.body);
  const bodyLine = body ? `  body: ${jsString(body)},\n` : '';

  return [
    `const response = await fetch(${jsString(request.url)}, {`,
    `  method: ${jsString(request.method.toUpperCase())},`,
    `  headers: ${safeJson(headers, { space: 2 }).replace(/\n/g, '\n  ')},`,
    bodyLine.trimEnd(),
    '});',
    'const data = await response.json();'
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}
