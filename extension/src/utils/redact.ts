const SECRET_KEY_PATTERN = /(authorization|password|token|secret|api[-_]?key|session|cookie)/i;

const BEARER_OR_BASIC_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi;

const QUERY_PARAM_PATTERN = /([?&](?:token|password|api[_-]?key|session|secret)=)([^&]+)/gi;

const JSON_PAIR_PATTERN =
  /("(?:authorization|password|token|secret|api[_-]?key|session(?:Id|ID)?|proxyApiKey)"\s*:\s*")([^"]+)(")/gi;

export function redactString(input: string): string {
  return input
    .replace(BEARER_OR_BASIC_PATTERN, '$1 ***')
    .replace(QUERY_PARAM_PATTERN, '$1***')
    .replace(JSON_PAIR_PATTERN, '$1***$3');
}

export function redactValue(value: unknown): unknown {
  return redactValueInternal(value, 0);
}

function redactValueInternal(value: unknown, depth: number): unknown {
  if (depth > 12) {
    return '[RedactedDepthLimit]';
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValueInternal(item, depth + 1));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(record)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = '***';
      continue;
    }

    output[key] = redactValueInternal(item, depth + 1);
  }

  return output;
}

export function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const next: Record<string, string> = {};

  for (const [name, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    const value = Array.isArray(rawValue)
      ? rawValue.map((item) => String(item)).join(', ')
      : String(rawValue);

    next[name] = SECRET_KEY_PATTERN.test(name) ? '***' : redactString(value);
  }

  return next;
}
