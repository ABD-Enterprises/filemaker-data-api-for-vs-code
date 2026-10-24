const RESERVED_WORDS = new Set<string>([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'as',
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'yield',
  'any',
  'boolean',
  'constructor',
  'declare',
  'get',
  'module',
  'require',
  'number',
  'set',
  'string',
  'symbol',
  'type',
  'from',
  'of'
]);

export interface NameMapping {
  rawName: string;
  friendlyName: string;
}

export interface NameMapResult {
  mappings: NameMapping[];
  rawToFriendly: Record<string, string>;
  friendlyToRaw: Record<string, string>;
}

export function sanitizeToIdentifier(rawName: string): string {
  const trimmed = rawName.trim();
  const normalized = trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();

  const words = normalized.length > 0 ? normalized.split(/\s+/g) : [];
  const base = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) {
        return lower;
      }

      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');

  const fallback = base.length > 0 ? base : 'field';
  const prefixed = /^[A-Za-z_$]/.test(fallback) ? fallback : `_${fallback}`;

  if (RESERVED_WORDS.has(prefixed)) {
    return `${prefixed}Field`;
  }

  return prefixed;
}

export function createNameMap(rawNames: string[]): NameMapResult {
  const rawToFriendly: Record<string, string> = Object.create(null) as Record<string, string>;
  const friendlyToRaw: Record<string, string> = Object.create(null) as Record<string, string>;
  const mappings: NameMapping[] = [];
  const usedFriendly = new Set<string>();

  for (const rawName of rawNames) {
    const base = sanitizeToIdentifier(rawName);
    const friendlyName = ensureUnique(base, usedFriendly);

    rawToFriendly[rawName] = friendlyName;
    friendlyToRaw[friendlyName] = rawName;
    mappings.push({ rawName, friendlyName });
  }

  return {
    mappings,
    rawToFriendly,
    friendlyToRaw
  };
}

export function toPascalCaseIdentifier(rawName: string): string {
  const friendly = sanitizeToIdentifier(rawName);
  return friendly.charAt(0).toUpperCase() + friendly.slice(1);
}

function ensureUnique(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let suffix = 2;
  let candidate = `${base}${suffix}`;

  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }

  used.add(candidate);
  return candidate;
}
