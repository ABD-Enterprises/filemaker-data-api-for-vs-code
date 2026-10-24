import { createHash } from 'crypto';

export function stableStringify(value: unknown): string {
  return stringifyValue(value);
}

export function hashObject(value: unknown): string {
  return hashObjectWithAlgorithm(value, 'sha256');
}

export function hashObjectWithAlgorithm(value: unknown, algorithm: string): string {
  const serialized = stableStringify(value);
  try {
    return createHash(algorithm).update(serialized).digest('hex');
  } catch {
    return createHash('sha256').update(serialized).digest('hex');
  }
}

function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyValue(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stringifyValue(record[key])}`);
    return `{${parts.join(',')}}`;
  }

  return JSON.stringify(value);
}
