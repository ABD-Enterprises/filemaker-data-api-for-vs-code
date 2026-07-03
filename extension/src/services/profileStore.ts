import type * as vscode from 'vscode';

import type { ConnectionProfile, SavedQuery } from '../types/fm';
import { FMClientError } from './errors';
import { validateDatabaseName, validateProfileId, validateServerUrl } from '../utils/jsonValidate';

const PROFILES_KEY = 'filemakerDataApiTools.profiles';
const ACTIVE_PROFILE_KEY = 'filemakerDataApiTools.activeProfileId';
const SAVED_QUERIES_KEY = 'filemakerDataApiTools.savedQueries';

export class ProfileStore {
  public constructor(
    private readonly globalState: vscode.Memento,
    private readonly workspaceState: vscode.Memento
  ) {}

  public async listProfiles(): Promise<ConnectionProfile[]> {
    const rawProfiles = this.globalState.get<unknown>(PROFILES_KEY, []);
    if (!Array.isArray(rawProfiles)) {
      return [];
    }

    return rawProfiles
      .map((profile) => normalizeProfile(profile))
      .filter((profile): profile is ConnectionProfile => Boolean(profile));
  }

  public async getProfile(id: string): Promise<ConnectionProfile | undefined> {
    const profiles = await this.listProfiles();
    return profiles.find((profile) => profile.id === id);
  }

  public async upsertProfile(profile: ConnectionProfile): Promise<void> {
    const normalizedProfile = validateConnectionProfile(profile);
    const profiles = await this.listProfiles();
    const existingIndex = profiles.findIndex((item) => item.id === normalizedProfile.id);

    if (existingIndex >= 0) {
      profiles[existingIndex] = normalizedProfile;
    } else {
      profiles.push(normalizedProfile);
    }

    await this.globalState.update(PROFILES_KEY, profiles);
  }

  public async removeProfile(profileId: string): Promise<void> {
    const profiles = await this.listProfiles();
    const filtered = profiles.filter((profile) => profile.id !== profileId);
    await this.globalState.update(PROFILES_KEY, filtered);

    const activeProfileId = this.getActiveProfileId();
    if (activeProfileId === profileId) {
      await this.setActiveProfileId(undefined);
    }

    const savedQueries = this.listSavedQueries();
    const remaining = savedQueries.filter((query) => query.profileId !== profileId);
    await this.workspaceState.update(SAVED_QUERIES_KEY, remaining);
  }

  public getActiveProfileId(): string | undefined {
    return this.globalState.get<string>(ACTIVE_PROFILE_KEY);
  }

  public async setActiveProfileId(profileId: string | undefined): Promise<void> {
    await this.globalState.update(ACTIVE_PROFILE_KEY, profileId);
  }

  public listSavedQueries(): SavedQuery[] {
    return this.workspaceState.get<SavedQuery[]>(SAVED_QUERIES_KEY, []);
  }

  public async saveQuery(query: SavedQuery): Promise<void> {
    const queries = this.listSavedQueries();
    const existingIndex = queries.findIndex((item) => item.id === query.id);

    if (existingIndex >= 0) {
      queries[existingIndex] = query;
    } else {
      queries.push(query);
    }

    await this.workspaceState.update(SAVED_QUERIES_KEY, queries);
  }

  public async removeSavedQuery(queryId: string): Promise<void> {
    const queries = this.listSavedQueries();
    await this.workspaceState.update(
      SAVED_QUERIES_KEY,
      queries.filter((query) => query.id !== queryId)
    );
  }
}

function normalizeProfile(value: unknown): ConnectionProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  try {
    return validateConnectionProfile(value as ConnectionProfile);
  } catch {
    return undefined;
  }
}

function validateConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  const idValidation = validateProfileId(profile.id);
  if (!idValidation.ok || !idValidation.value) {
    throw new FMClientError(idValidation.error ?? 'Profile ID is invalid.');
  }

  const serverUrlValidation = validateServerUrl(profile.serverUrl);
  if (!serverUrlValidation.ok || !serverUrlValidation.value) {
    throw new FMClientError(serverUrlValidation.error ?? 'Server URL is invalid.');
  }

  const databaseValidation = validateDatabaseName(profile.database);
  if (!databaseValidation.ok || !databaseValidation.value) {
    throw new FMClientError(databaseValidation.error ?? 'Database name is invalid.');
  }

  if (profile.authMode !== 'direct' && profile.authMode !== 'proxy') {
    throw new FMClientError('Auth mode must be "direct" or "proxy".');
  }

  return {
    ...profile,
    id: idValidation.value,
    name: profile.name.trim(),
    serverUrl: serverUrlValidation.value,
    database: databaseValidation.value,
    username: profile.username?.trim() || undefined,
    apiBasePath: profile.apiBasePath?.trim() || undefined,
    apiVersionPath: profile.apiVersionPath?.trim() || undefined,
    proxyEndpoint: profile.proxyEndpoint?.trim() || undefined,
    allowSelfSigned: profile.allowSelfSigned === true ? true : undefined,
    caBundlePath: profile.caBundlePath?.trim() || undefined
  };
}
