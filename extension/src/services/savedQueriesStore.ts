import { randomUUID } from 'crypto';

import type * as vscode from 'vscode';

import type { SavedQueriesDocument, SavedQuery, SavedQueryScope } from '../types/fm';
import { assertObjectArray, validateObjectArray } from '../utils/jsonValidate';

const DATA_KEY = 'filemaker.savedQueries.items';
const VERSION_KEY = 'filemaker.savedQueries.schemaVersion';
const LEGACY_KEY = 'filemakerDataApiTools.savedQueries';
const CURRENT_SCHEMA_VERSION = 1;

interface LegacySavedQuery {
  id?: string;
  name?: string;
  profileId?: string;
  database?: string;
  layout?: string;
  findJson?: string;
  sortJson?: string;
  limit?: number;
  offset?: number;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
}

export interface ImportSavedQueriesResult {
  imported: number;
  updated: number;
  skipped: number;
}

export class SavedQueriesStore {
  private initialized = false;
  private readonly getScopeFromConfig: () => SavedQueryScope;

  public constructor(
    private readonly globalState: vscode.Memento,
    private readonly workspaceState: vscode.Memento,
    options?: {
      getScope?: () => SavedQueryScope;
    }
  ) {
    this.getScopeFromConfig = options?.getScope ?? (() => 'workspace');
  }

  public async listSavedQueries(options?: {
    profileId?: string;
    scope?: SavedQueryScope;
  }): Promise<SavedQuery[]> {
    await this.ensureInitialized();

    const scope = options?.scope ?? this.getConfiguredScope();
    const queries = this.getState(scope).get<SavedQuery[]>(DATA_KEY, []);

    return queries
      .filter((query) => !options?.profileId || query.profileId === options.profileId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async getSavedQuery(id: string, scope?: SavedQueryScope): Promise<SavedQuery | undefined> {
    const queries = await this.listSavedQueries({ scope });
    return queries.find((query) => query.id === id);
  }

  public async saveSavedQuery(
    query: Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'> & {
      id?: string;
      createdAt?: string;
      updatedAt?: string;
    },
    scope?: SavedQueryScope
  ): Promise<SavedQuery> {
    await this.ensureInitialized();

    const targetScope = scope ?? this.getConfiguredScope();
    const state = this.getState(targetScope);
    const existing = state.get<SavedQuery[]>(DATA_KEY, []);
    const now = new Date().toISOString();

    const normalized = this.normalizeSavedQuery({
      ...query,
      id: query.id ?? randomUUID(),
      createdAt: query.createdAt ?? now,
      updatedAt: now
    });

    const index = existing.findIndex((item) => item.id === normalized.id);
    const next = [...existing];
    const existingItem = index >= 0 ? existing[index] : undefined;

    if (index >= 0 && existingItem) {
      next[index] = {
        ...normalized,
        createdAt: existingItem.createdAt
      };
    } else {
      next.push(normalized);
    }

    await state.update(DATA_KEY, next);
    return next.find((item) => item.id === normalized.id) ?? normalized;
  }

  public async touchLastRun(queryId: string, scope?: SavedQueryScope): Promise<void> {
    await this.ensureInitialized();

    const targetScope = scope ?? this.getConfiguredScope();
    const state = this.getState(targetScope);
    const existing = state.get<SavedQuery[]>(DATA_KEY, []);
    const now = new Date().toISOString();

    const updated = existing.map((query) =>
      query.id === queryId
        ? {
            ...query,
            lastRunAt: now,
            updatedAt: now
          }
        : query
    );

    await state.update(DATA_KEY, updated);
  }

  public async removeSavedQuery(id: string, scope?: SavedQueryScope): Promise<boolean> {
    await this.ensureInitialized();

    const targetScope = scope ?? this.getConfiguredScope();
    const state = this.getState(targetScope);
    const existing = state.get<SavedQuery[]>(DATA_KEY, []);

    const next = existing.filter((query) => query.id !== id);
    await state.update(DATA_KEY, next);

    return next.length !== existing.length;
  }

  public async removeQueriesForProfile(profileId: string): Promise<void> {
    await this.ensureInitialized();

    const workspaceQueries = this.workspaceState.get<SavedQuery[]>(DATA_KEY, []);
    const globalQueries = this.globalState.get<SavedQuery[]>(DATA_KEY, []);

    await this.workspaceState.update(
      DATA_KEY,
      workspaceQueries.filter((query) => query.profileId !== profileId)
    );

    await this.globalState.update(
      DATA_KEY,
      globalQueries.filter((query) => query.profileId !== profileId)
    );
  }

  public async exportSavedQueries(scope?: SavedQueryScope): Promise<SavedQueriesDocument> {
    const queries = await this.listSavedQueries({ scope });

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      queries
    };
  }

  public async importSavedQueries(
    rawJson: string,
    scope?: SavedQueryScope
  ): Promise<ImportSavedQueriesResult> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error('That file is not valid JSON. Choose a saved queries JSON file and try again.');
    }

    const queries = this.parseImportPayload(parsed);
    await this.ensureInitialized();

    const targetScope = scope ?? this.getConfiguredScope();
    const state = this.getState(targetScope);
    const existing = state.get<SavedQuery[]>(DATA_KEY, []);

    const byId = new Map(existing.map((query) => [query.id, query]));

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const rawQuery of queries) {
      try {
        const normalized = this.normalizeSavedQuery(rawQuery);
        const hadExisting = byId.has(normalized.id);
        byId.set(normalized.id, {
          ...normalized,
          createdAt: hadExisting ? byId.get(normalized.id)?.createdAt ?? normalized.createdAt : normalized.createdAt,
          updatedAt: new Date().toISOString()
        });

        if (hadExisting) {
          updated += 1;
        } else {
          imported += 1;
        }
      } catch {
        skipped += 1;
      }
    }

    await state.update(DATA_KEY, Array.from(byId.values()));

    return {
      imported,
      updated,
      skipped
    };
  }

  public createSavedQuery(input: {
    name: string;
    profileId: string;
    database?: string;
    layout: string;
    findJson: Array<Record<string, unknown>>;
    sortJson?: Array<Record<string, unknown>>;
    limit?: number;
    offset?: number;
  }): SavedQuery {
    const now = new Date().toISOString();

    return {
      id: randomUUID(),
      name: input.name.trim(),
      profileId: input.profileId,
      database: input.database,
      layout: input.layout,
      findJson: input.findJson,
      sortJson: input.sortJson,
      limit: input.limit,
      offset: input.offset,
      createdAt: now,
      updatedAt: now
    };
  }

  private getConfiguredScope(): SavedQueryScope {
    const configured = this.getScopeFromConfig();

    if (configured === 'global') {
      return 'global';
    }

    return 'workspace';
  }

  private getState(scope: SavedQueryScope): vscode.Memento {
    return scope === 'global' ? this.globalState : this.workspaceState;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.migrateState(this.workspaceState);
    await this.migrateState(this.globalState);

    this.initialized = true;
  }

  private async migrateState(state: vscode.Memento): Promise<void> {
    const version = state.get<number>(VERSION_KEY);

    if (version === CURRENT_SCHEMA_VERSION) {
      return;
    }

    const existing = state.get<SavedQuery[]>(DATA_KEY, []).map((query) => this.normalizeSavedQuery(query));
    const legacy = state.get<LegacySavedQuery[]>(LEGACY_KEY, []);
    const migratedLegacy = legacy
      .map((query) => this.fromLegacyQuery(query))
      .filter((query): query is SavedQuery => Boolean(query));

    const deduped = dedupeById([...existing, ...migratedLegacy]);

    await state.update(DATA_KEY, deduped);
    await state.update(VERSION_KEY, CURRENT_SCHEMA_VERSION);

    if (legacy.length > 0) {
      await state.update(LEGACY_KEY, undefined);
    }
  }

  private fromLegacyQuery(query: LegacySavedQuery): SavedQuery | undefined {
    if (!query.profileId || !query.layout || !query.name) {
      return undefined;
    }

    const findArray = query.findJson ? safeParseObjectArray(query.findJson, 'Find JSON') : [{ }];
    const sortArray = query.sortJson ? safeParseObjectArray(query.sortJson, 'Sort JSON') : undefined;

    const now = new Date().toISOString();

    return {
      id: query.id ?? randomUUID(),
      name: query.name,
      profileId: query.profileId,
      database: query.database,
      layout: query.layout,
      findJson: findArray,
      sortJson: sortArray,
      limit: query.limit,
      offset: query.offset,
      createdAt: query.createdAt ?? now,
      updatedAt: query.updatedAt ?? query.createdAt ?? now,
      lastRunAt: query.lastRunAt
    };
  }

  private normalizeSavedQuery(query: SavedQuery): SavedQuery {
    const now = new Date().toISOString();

    return {
      id: query.id || randomUUID(),
      name: query.name.trim(),
      profileId: query.profileId,
      database: query.database,
      layout: query.layout,
      findJson: assertObjectArray(query.findJson, 'Find JSON'),
      sortJson: query.sortJson ? assertObjectArray(query.sortJson, 'Sort JSON') : undefined,
      limit: query.limit,
      offset: query.offset,
      createdAt: query.createdAt ?? now,
      updatedAt: query.updatedAt ?? now,
      lastRunAt: query.lastRunAt
    };
  }

  private parseImportPayload(value: unknown): SavedQuery[] {
    const queries: unknown = Array.isArray(value) ? value
      : value && typeof value === 'object' ? (value as Record<string, unknown>).queries : undefined;
    if (Array.isArray(queries) && queries.every((query: unknown) => {
      if (!query || typeof query !== 'object' || Array.isArray(query)) return false;
      const entry = query as Record<string, unknown>;
      return typeof entry.name === 'string' && typeof entry.profileId === 'string' &&
        typeof entry.layout === 'string' && validateObjectArray(entry.findJson, 'Find JSON').ok &&
        (entry.sortJson === undefined || validateObjectArray(entry.sortJson, 'Sort JSON').ok);
    })) {
      return queries as SavedQuery[];
    }

    throw new Error('That JSON file does not contain saved queries. Choose an exported saved queries file or a JSON list of saved queries.');
  }
}

function dedupeById(queries: SavedQuery[]): SavedQuery[] {
  const byId = new Map<string, SavedQuery>();

  for (const query of queries) {
    byId.set(query.id, query);
  }

  return Array.from(byId.values());
}

function safeParseObjectArray(input: string, label: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(input);
    return assertObjectArray(parsed, label);
  } catch {
    return [{ }];
  }
}
