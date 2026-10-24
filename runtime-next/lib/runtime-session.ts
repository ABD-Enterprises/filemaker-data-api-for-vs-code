import type { LayoutDefinition } from '@fmweb/shared';

import type { RuntimeRecord } from './bridge-client';

const RUNTIME_SESSION_KEY = 'fmweb.runtime.session.v1';
const RUNTIME_SESSION_SCHEMA_VERSION = 1;
const MAX_FOUND_SET_RECORDS = 250;

interface RuntimeSessionState {
  schemaVersion: number;
  snapshots: Record<string, RuntimeSessionSnapshot>;
  navigationIntent?: RuntimeNavigationIntent;
}

export interface RuntimeSessionSnapshot {
  foundSet: RuntimeRecord[];
  currentIndex: number;
  updatedAt: string;
}

export interface RuntimeNavigationIntent {
  targetLayoutId: string;
  sourceLayoutId?: string;
  sourceLayoutName: string;
  sourceFmLayoutName?: string;
  recordId?: string;
  currentRecordIndex?: number;
  foundSetRecordIds?: string[];
  createdAt: string;
}

export function loadLayoutSnapshot(
  layout: Pick<LayoutDefinition, 'id' | 'name' | 'fmLayoutName'>,
  storage = resolveStorage()
): RuntimeSessionSnapshot | undefined {
  if (!storage) {
    return undefined;
  }

  const state = readState(storage);
  const keys = buildLayoutSnapshotKeys(layout);
  for (const key of keys) {
    const snapshot = state.snapshots[key];
    if (snapshot) {
      return snapshot;
    }
  }

  return undefined;
}

export function saveLayoutSnapshot(
  layout: Pick<LayoutDefinition, 'id' | 'name' | 'fmLayoutName'>,
  foundSet: RuntimeRecord[],
  currentIndex: number,
  storage = resolveStorage()
): void {
  if (!storage) {
    return;
  }

  const sanitizedRecords = foundSet.slice(0, MAX_FOUND_SET_RECORDS).map((record) => ({
    ...record,
    fieldData: { ...record.fieldData },
    portalData: record.portalData
      ? Object.fromEntries(
          Object.entries(record.portalData).map(([key, rows]) => [key, Array.isArray(rows) ? rows.slice(0, 100) : []])
        )
      : undefined
  }));

  const clampedIndex =
    sanitizedRecords.length === 0 ? 0 : Math.max(0, Math.min(Math.floor(currentIndex), sanitizedRecords.length - 1));
  const snapshot: RuntimeSessionSnapshot = {
    foundSet: sanitizedRecords,
    currentIndex: clampedIndex,
    updatedAt: new Date().toISOString()
  };

  const state = readState(storage);
  for (const key of buildLayoutSnapshotKeys(layout)) {
    state.snapshots[key] = snapshot;
  }

  writeState(storage, state);
}

export function saveNavigationIntent(
  intent: Omit<RuntimeNavigationIntent, 'createdAt'>,
  storage = resolveStorage()
): void {
  if (!storage) {
    return;
  }

  const state = readState(storage);
  state.navigationIntent = {
    ...intent,
    recordId: normalizeString(intent.recordId),
    sourceLayoutId: normalizeString(intent.sourceLayoutId),
    sourceLayoutName: intent.sourceLayoutName,
    sourceFmLayoutName: normalizeString(intent.sourceFmLayoutName),
    currentRecordIndex:
      typeof intent.currentRecordIndex === 'number' && Number.isFinite(intent.currentRecordIndex)
        ? Math.max(0, Math.floor(intent.currentRecordIndex))
        : undefined,
    foundSetRecordIds: Array.isArray(intent.foundSetRecordIds)
      ? intent.foundSetRecordIds
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .slice(0, MAX_FOUND_SET_RECORDS)
      : undefined,
    createdAt: new Date().toISOString()
  };
  writeState(storage, state);
}

export function consumeNavigationIntent(
  targetLayoutId: string,
  storage = resolveStorage()
): RuntimeNavigationIntent | undefined {
  if (!storage) {
    return undefined;
  }

  const state = readState(storage);
  const intent = state.navigationIntent;
  if (!intent) {
    return undefined;
  }

  if (intent.targetLayoutId !== targetLayoutId) {
    return undefined;
  }

  delete state.navigationIntent;
  writeState(storage, state);
  return intent;
}

function readState(storage: Storage): RuntimeSessionState {
  try {
    const raw = storage.getItem(RUNTIME_SESSION_KEY);
    if (!raw) {
      return createEmptyState();
    }

    const parsed = JSON.parse(raw) as RuntimeSessionState;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== RUNTIME_SESSION_SCHEMA_VERSION ||
      !parsed.snapshots ||
      typeof parsed.snapshots !== 'object'
    ) {
      return createEmptyState();
    }

    return parsed;
  } catch {
    return createEmptyState();
  }
}

function writeState(storage: Storage, state: RuntimeSessionState): void {
  storage.setItem(RUNTIME_SESSION_KEY, JSON.stringify(state));
}

function createEmptyState(): RuntimeSessionState {
  return {
    schemaVersion: RUNTIME_SESSION_SCHEMA_VERSION,
    snapshots: {}
  };
}

function buildLayoutSnapshotKeys(layout: Pick<LayoutDefinition, 'id' | 'name' | 'fmLayoutName'>): string[] {
  const keys = [`layout:${layout.id}`];
  const contextKey = normalizeLayoutContextKey(layout.fmLayoutName ?? layout.name);
  if (contextKey) {
    keys.push(`context:${contextKey}`);
  }

  return keys;
}

function normalizeLayoutContextKey(value: string | undefined): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }

  return normalized.toLowerCase().replace(/\s+/g, ' ');
}

function normalizeString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveStorage(): Storage | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
