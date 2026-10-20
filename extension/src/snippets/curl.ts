import { safeJson, shellComment, shellQuote } from './escape';
import type { RequestSpec, SnippetOptions } from './model';
import { bodyJson, pathAndQuery } from './render';

const STYLE = { modId: '<modId>' };

export function renderCurl(spec: RequestSpec, options: SnippetOptions = {}): string {
  const lines: string[] = [...spec.notes.map((note) => shellComment(note))];
  const url = `${spec.host}${pathAndQuery(spec, STYLE)}`;
  // Preserve the configured URL while disabling curl's bracket/brace expansion.
  const parts: string[] = ['curl', ...(/[[\]{}]/.test(url) ? ['--globoff'] : []), '-X', spec.method, shellQuote(url)];

  if (spec.body?.kind === 'json') {
    parts.push('-H', shellQuote('Content-Type: application/json'));
  }

  if (spec.auth === 'basic') {
    // The shell expands these two variables; the account is never written into the command.
    parts.push('-u', '"$FM_USERNAME:$FM_PASSWORD"');
  } else if (options.includeAuthHeader) {
    parts.push('-H', spec.auth === 'proxy' ? '"Authorization: Bearer $FM_PROXY_API_KEY"' : '"Authorization: Bearer $FM_TOKEN"');
  } else {
    parts.push('-H', shellQuote('Authorization: Bearer <REDACTED>'));
  }

  if (spec.body?.kind === 'json') {
    parts.push(
      '--data-raw',
      shellQuote(bodyJson(spec.body.value, { placeholderLiteral: (name) => safeJson(`<${name}>`) }))
    );
  } else if (spec.body?.kind === 'upload') {
    // curl builds the multipart body and its Content-Type itself.
    parts.push('-F', shellQuote('upload=@./file-to-upload'));
  }

  lines.push(parts.join(' '));
  return lines.join('\n');
}
