import { randomUUID } from 'crypto';

import type * as vscode from 'vscode';

import type { EnvironmentSet } from '../types/fm';
import type { EnvironmentSetSeed } from './roleGuard';

const ENVIRONMENT_SET_KEY = 'filemaker.enterprise.environmentSets';
const ENVIRONMENT_SET_VERSION_KEY = 'filemaker.enterprise.environmentSets.version';
const ENVIRONMENT_SET_SCHEMA_VERSION = 1;

export class EnvironmentSetStore {
  private initialized = false;

  public constructor(private readonly workspaceState: vscode.Memento) {}

  public async listEnvironmentSets(): Promise<EnvironmentSet[]> {
    await this.ensureInitialized();

    return this.workspaceState
      .get<EnvironmentSet[]>(ENVIRONMENT_SET_KEY, [])
      .filter((item): item is EnvironmentSet => Boolean(normalizeEnvironmentSet(item)))
      .map((item) => normalizeEnvironmentSet(item) as EnvironmentSet)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async getEnvironmentSet(id: string): Promise<EnvironmentSet | undefined> {
    const items = await this.listEnvironmentSets();
    return items.find((item) => item.id === id);
  }

  public async upsertEnvironmentSet(input: {
    id?: string;
    name: string;
    profiles: string[];
  }): Promise<EnvironmentSet> {
    await this.ensureInitialized();

    const normalizedName = input.name.trim();
    if (!normalizedName) {
      throw new Error('Environment set name is required.');
    }

    const profiles = Array.from(
      new Set(input.profiles.map((profile) => profile.trim()).filter((profile) => profile.length > 0))
    );

    if (profiles.length < 2) {
      throw new Error('Environment sets must include at least two profiles.');
    }

    const existing = this.workspaceState.get<EnvironmentSet[]>(ENVIRONMENT_SET_KEY, []);
    const id = input.id ?? randomUUID();
    const nowIso = new Date().toISOString();

    const current = existing.find((item) => item.id === id);
    const nextItem: EnvironmentSet = {
      id,
      name: normalizedName,
      profiles,
      createdAt: current?.createdAt ?? nowIso
    };

    const next = [...existing.filter((item) => item.id !== id), nextItem];
    await this.workspaceState.update(ENVIRONMENT_SET_KEY, next);

    return nextItem;
  }

  public async removeEnvironmentSet(id: string): Promise<void> {
    await this.ensureInitialized();

    const existing = this.workspaceState.get<EnvironmentSet[]>(ENVIRONMENT_SET_KEY, []);
    const next = existing.filter((item) => item.id !== id);

    await this.workspaceState.update(ENVIRONMENT_SET_KEY, next);
  }

  public async ensureSeeded(seeds: EnvironmentSetSeed[]): Promise<void> {
    if (seeds.length === 0) {
      return;
    }

    await this.ensureInitialized();

    const existing = this.workspaceState.get<EnvironmentSet[]>(ENVIRONMENT_SET_KEY, []);
    const byName = new Map(existing.map((item) => [item.name.toLowerCase(), item]));
    const toAdd: EnvironmentSet[] = [];

    for (const seed of seeds) {
      if (byName.has(seed.name.toLowerCase())) {
        continue;
      }

      const profiles = Array.from(
        new Set(seed.profiles.map((profile) => profile.trim()).filter((profile) => profile.length > 0))
      );
      if (profiles.length < 2) {
        continue;
      }

      toAdd.push({
        id: randomUUID(),
        name: seed.name,
        profiles,
        createdAt: new Date().toISOString()
      });
    }

    if (toAdd.length === 0) {
      return;
    }

    await this.workspaceState.update(ENVIRONMENT_SET_KEY, [...existing, ...toAdd]);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const version = this.workspaceState.get<number>(ENVIRONMENT_SET_VERSION_KEY);
    if (version !== ENVIRONMENT_SET_SCHEMA_VERSION) {
      const legacy = this.workspaceState.get<EnvironmentSet[]>(ENVIRONMENT_SET_KEY, []);
      const normalized = legacy
        .map((item) => normalizeEnvironmentSet(item))
        .filter((item): item is EnvironmentSet => Boolean(item));
      await this.workspaceState.update(ENVIRONMENT_SET_KEY, normalized);
      await this.workspaceState.update(ENVIRONMENT_SET_VERSION_KEY, ENVIRONMENT_SET_SCHEMA_VERSION);
    }

    this.initialized = true;
  }
}

function normalizeEnvironmentSet(input: EnvironmentSet | undefined): EnvironmentSet | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const id = typeof input.id === 'string' ? input.id : '';
  const createdAt = typeof input.createdAt === 'string' ? input.createdAt : '';

  const profiles = Array.isArray(input.profiles)
    ? Array.from(
        new Set(
          input.profiles
            .filter((profile): profile is string => typeof profile === 'string')
            .map((profile) => profile.trim())
            .filter((profile) => profile.length > 0)
        )
      )
    : [];

  if (!id || !name || !createdAt || profiles.length < 2) {
    return undefined;
  }

  return {
    id,
    name,
    createdAt,
    profiles
  };
}
