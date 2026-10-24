const CHILD_LAYOUT_KEYS = ['folderLayoutNames', 'layouts', 'children', 'items', 'layoutNames'] as const;

// FileMaker layout list payloads can include folder nodes with nested layout arrays.
// This parser walks mixed shapes and returns a flat layout name list. Names are kept exactly; only an
// identical name (which the Data API cannot tell apart either) appears once.

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

/**
 * A layout name exactly as the server sent it. The Data API addresses a layout by its exact name
 * (`/layouts/<name>`), so a name with a leading or trailing space is a different layout from the
 * same name without it, and trimming would make the first one impossible to open. Only a name that
 * is empty or all whitespace is dropped.
 */
function toName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.trim().length > 0 ? value : undefined;
}

function collectChildNodes(entry: Record<string, unknown>): unknown[] {
  const children: unknown[] = [];

  for (const key of CHILD_LAYOUT_KEYS) {
    const value = entry[key];
    if (Array.isArray(value)) {
      children.push(...value);
    }
  }

  return children;
}

function isFolderNode(entry: Record<string, unknown>, childNodes: unknown[]): boolean {
  if (childNodes.length > 0) {
    return true;
  }

  if (entry.isFolder === true || entry.folder === true) {
    return true;
  }

  if (typeof entry.type === 'string' && entry.type.toLowerCase() === 'folder') {
    return true;
  }

  return false;
}

function pushUnique(target: string[], seen: Set<string>, name: string): void {
  if (seen.has(name)) {
    return;
  }

  seen.add(name);
  target.push(name);
}

function visitLayoutNode(value: unknown, target: string[], seen: Set<string>): void {
  if (typeof value === 'string') {
    const name = toName(value);
    if (name) {
      pushUnique(target, seen, name);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitLayoutNode(item, target, seen);
    }
    return;
  }

  const entry = toRecord(value);
  if (!entry) {
    return;
  }

  const childNodes = collectChildNodes(entry);
  const folderNode = isFolderNode(entry, childNodes);
  const name =
    toName(entry.name) ??
    toName(entry.layoutName) ??
    toName(entry.layout) ??
    toName(entry.displayName);

  if (name && !folderNode) {
    pushUnique(target, seen, name);
  }

  for (const child of childNodes) {
    visitLayoutNode(child, target, seen);
  }
}

export function extractLayoutNames(rawLayouts: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  visitLayoutNode(rawLayouts, names, seen);

  return names;
}
