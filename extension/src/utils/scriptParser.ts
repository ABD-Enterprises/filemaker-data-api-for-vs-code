const CHILD_SCRIPT_KEYS = ['scripts', 'children', 'items', 'folderScriptNames'] as const;

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function toName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  // The name exactly as the server sent it; only a blank name is dropped.
  return value.trim().length > 0 ? value : undefined;
}

function pushUnique(target: string[], seen: Set<string>, name: string): void {
  if (seen.has(name)) {
    return;
  }

  seen.add(name);
  target.push(name);
}

function visitScriptNode(value: unknown, target: string[], seen: Set<string>): void {
  if (typeof value === 'string') {
    const name = toName(value);
    if (name) {
      pushUnique(target, seen, name);
    }

    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitScriptNode(item, target, seen);
    }

    return;
  }

  const entry = toRecord(value);
  if (!entry) {
    return;
  }

  const name =
    toName(entry.name) ??
    toName(entry.scriptName) ??
    toName(entry.script) ??
    toName(entry.displayName);

  const children: unknown[] = [];
  for (const key of CHILD_SCRIPT_KEYS) {
    const child = entry[key];
    if (Array.isArray(child)) {
      children.push(...child);
    }
  }

  const isFolder =
    children.length > 0 ||
    entry.isFolder === true ||
    (typeof entry.type === 'string' && entry.type.toLowerCase() === 'folder');

  if (name && !isFolder) {
    pushUnique(target, seen, name);
  }

  for (const child of children) {
    visitScriptNode(child, target, seen);
  }
}

export function extractScriptNames(rawScripts: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  visitScriptNode(rawScripts, names, seen);

  return names;
}
