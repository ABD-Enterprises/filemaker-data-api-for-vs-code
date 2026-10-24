import type { LayoutDefinition } from '../fmweb/layoutSchema';

export const FMWEB_PROJECT_SCHEMA_VERSION = 1;
export const FMWEB_METADATA_SCHEMA_VERSION = 1;

export interface FmWebEnvironmentProfile {
  id: string;
  name: string;
  profileId: string;
  database?: string;
}

export interface FmWebFeatureFlags {
  runtimeGenerationEnabled: boolean;
  bridgeServerEnabled: boolean;
  commercialModeEnabled: boolean;
}

export interface FmWebLicensePlaceholder {
  tier?: string;
  keyId?: string;
}

export interface FmWebProjectConfig {
  schemaVersion: number;
  name: string;
  activeProfileId?: string;
  activeEnvironmentId?: string;
  environments: FmWebEnvironmentProfile[];
  featureFlags: FmWebFeatureFlags;
  license?: FmWebLicensePlaceholder;
  createdAt: string;
  updatedAt: string;
}

export interface FmWebLayoutMetadata {
  layoutName: string;
  fields: string[];
  tableOccurrences: string[];
  metadataFile: string;
}

export interface FmWebMetadataCache {
  schemaVersion: number;
  syncedAt: string;
  profileId: string;
  profileName: string;
  database: string;
  layouts: string[];
  scripts: string[];
  layoutMetadata: FmWebLayoutMetadata[];
}

export interface FmWebSyncSummary {
  layoutCount: number;
  scriptCount: number;
  tableOccurrenceCount: number;
  fieldCount: number;
}

export interface FmWebLayoutLoadResult {
  layout: LayoutDefinition;
  source: 'created' | 'existing';
  filePath: string;
}
