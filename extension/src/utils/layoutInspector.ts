import type { FileMakerFieldMetadata, SchemaMetadataResult, ValueList } from '../types/fm';
import { extractPortalMetadata } from './portalUtils';
import { extractValueLists } from './valueListParser';

export interface LayoutInspectorField {
  name: string;
  type?: string;
  repetitions?: number;
  isGlobal: boolean;
  validation?: Record<string, unknown>;
}

export interface LayoutInspectorPortal {
  key: string;
  relatedTable: string;
  fields: Array<{
    name: string;
    type?: string;
  }>;
}

export interface LayoutInspectorValidationRule {
  fieldName: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface LayoutInspectorModel {
  fields: LayoutInspectorField[];
  portals: LayoutInspectorPortal[];
  valueLists: ValueList[];
  validations: LayoutInspectorValidationRule[];
}

export function buildLayoutInspectorModel(schema: SchemaMetadataResult): LayoutInspectorModel {
  const metadata = schema.metadata ?? {};
  const fields = schema.fields.map(toInspectorField);
  const portals = extractInspectorPortals(metadata);
  const valueLists = extractValueLists(metadata);
  const validations = fields
    .filter((field) => field.validation && Object.keys(field.validation).length > 0)
    .map((field) => ({
      fieldName: field.name,
      summary: summarizeValidation(field.validation),
      details: field.validation ?? {}
    }));

  return {
    fields,
    portals,
    valueLists,
    validations
  };
}

function toInspectorField(field: FileMakerFieldMetadata): LayoutInspectorField {
  return {
    name: field.name,
    type: field.result ?? field.type,
    repetitions: field.repetitions,
    isGlobal: isGlobalField(field),
    validation: field.validation
  };
}

function isGlobalField(field: FileMakerFieldMetadata): boolean {
  const rawGlobal = field.global ?? field.isGlobal ?? field.globalStorage;
  if (typeof rawGlobal === 'boolean') {
    return rawGlobal;
  }

  if (typeof rawGlobal === 'string' && rawGlobal.toLowerCase() === 'true') {
    return true;
  }

  const storage = field.storage ?? field.storageType;
  return typeof storage === 'string' && storage.toLowerCase().includes('global');
}

function extractInspectorPortals(metadata: Record<string, unknown>): LayoutInspectorPortal[] {
  const portalMetadata = extractPortalMetadata(metadata);

  return Object.entries(portalMetadata)
    .map(([key, fields]) => ({
      key,
      relatedTable: inferRelatedTable(
        key,
        fields.map((field) => field.name)
      ),
      fields: fields.map((field) => ({
        name: field.name,
        type: field.result ?? field.type
      }))
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function inferRelatedTable(portalKey: string, fieldNames: string[]): string {
  const tablePrefixes = fieldNames
    .map((fieldName) => {
      const separatorIndex = fieldName.indexOf('::');
      return separatorIndex > 0 ? fieldName.slice(0, separatorIndex) : undefined;
    })
    .filter((value): value is string => Boolean(value));

  const firstPrefix = tablePrefixes[0];
  if (firstPrefix) {
    return firstPrefix;
  }

  return portalKey;
}

function summarizeValidation(validation: Record<string, unknown> | undefined): string {
  if (!validation) {
    return '';
  }

  const enabledEntries = Object.entries(validation).filter(([, value]) => isMeaningfulRule(value));
  if (enabledEntries.length === 0) {
    return 'Validation configured';
  }

  return enabledEntries
    .map(([key, value]) => {
      if (typeof value === 'boolean') {
        return key;
      }

      if (typeof value === 'string' || typeof value === 'number') {
        return `${key}: ${value}`;
      }

      return key;
    })
    .join(', ');
}

function isMeaningfulRule(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }

  return true;
}
