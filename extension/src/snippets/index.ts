import type { ConnectionProfile } from '../types/fm';
import { renderCurl } from './curl';
import { renderFetch } from './fetch';
import { renderHttp } from './http';
import {
  SnippetError,
  type RequestSpec,
  type SnippetFormat,
  type SnippetOperation,
  type SnippetOptions
} from './model';
import { buildRequestSpec } from './operations';
import { renderPostman } from './postman';
import { renderTypeScript } from './typescript';

export * from './model';
export { buildRequestSpec } from './operations';

/**
 * A last check on the finished text: a bearer or basic credential that is not a placeholder must
 * never be written. The text is built from placeholders and redacted input, so this fails closed
 * if a change ever lets a real token through.
 */
const LIVE_CREDENTIAL = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{4,}=*/i;

export function renderSnippet(spec: RequestSpec, format: SnippetFormat, options: SnippetOptions = {}): string {
  let text: string;
  switch (format) {
    case 'curl':
      text = renderCurl(spec, options);
      break;
    case 'fetch':
      text = renderFetch(spec, options);
      break;
    case 'http':
      text = renderHttp(spec, options);
      break;
    case 'postman':
      text = renderPostman(spec, options);
      break;
    case 'typescript':
      text = renderTypeScript(spec, options);
      break;
  }
  if (LIVE_CREDENTIAL.test(text.replace(/\b(Bearer|Basic)\s+(?:<REDACTED>|\*\*\*)/gi, ''))) {
    throw new SnippetError('Refusing to copy a request that contains what looks like a live credential.');
  }
  return text;
}

/** The one entry point: the request for `operation` on `profile`, as `format`. */
export function generateSnippet(
  profile: ConnectionProfile,
  operation: SnippetOperation,
  format: SnippetFormat,
  options: SnippetOptions = {}
): string {
  return renderSnippet(buildRequestSpec(profile, operation), format, options);
}
