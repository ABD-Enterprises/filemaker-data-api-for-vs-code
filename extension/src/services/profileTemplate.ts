import * as vscode from 'vscode';

import type { AuthMode } from '../types/fm';
import { validateDatabaseName, validateServerUrl } from '../utils/jsonValidate';

export const PROFILE_TEMPLATE_RELATIVE_PATH = '.filemaker/profile-template.json';
export const PROFILE_TEMPLATE_LOCKED_FIELDS = [
  'serverUrl',
  'database',
  'apiBasePath',
  'apiVersionPath'
] as const;

export type ProfileTemplateLockedField = (typeof PROFILE_TEMPLATE_LOCKED_FIELDS)[number];

export interface ConnectionProfileTemplate {
  name?: string;
  authMode?: AuthMode;
  serverUrl?: string;
  database?: string;
  apiBasePath?: string;
  apiVersionPath?: string;
  username?: string;
  proxyEndpoint?: string;
  locked?: boolean;
}

export interface ProfileTemplateLoadResult {
  template?: ConnectionProfileTemplate;
  sourcePath?: string;
  warning?: string;
}

const ALLOWED_FIELDS = new Set([
  'name',
  'authMode',
  'serverUrl',
  'database',
  'apiBasePath',
  'apiVersionPath',
  'username',
  'proxyEndpoint',
  'locked'
]);

const CREDENTIAL_FIELDS = new Set([
  'password',
  'proxyapikey',
  'sessiontoken',
  'token',
  'bearertoken',
  'apikey'
]);

export async function loadConnectionProfileTemplate(): Promise<ProfileTemplateLoadResult> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return {};
  }

  const uri = vscode.Uri.joinPath(workspaceFolder.uri, '.filemaker', 'profile-template.json');

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return parseConnectionProfileTemplate(
      Buffer.from(bytes).toString('utf8'),
      PROFILE_TEMPLATE_RELATIVE_PATH
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    return {
      sourcePath: PROFILE_TEMPLATE_RELATIVE_PATH,
      warning: `Could not read ${PROFILE_TEMPLATE_RELATIVE_PATH}. Continue manually or fix the template file.`
    };
  }
}

export function parseConnectionProfileTemplate(
  raw: string,
  sourcePath = PROFILE_TEMPLATE_RELATIVE_PATH
): ProfileTemplateLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      sourcePath,
      warning: `Could not parse ${sourcePath}. Continue manually or fix the template JSON.`
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      sourcePath,
      warning: `${sourcePath} must contain a JSON object. Continue manually or fix the template file.`
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (CREDENTIAL_FIELDS.has(field.toLowerCase())) {
      return {
        sourcePath,
        warning: `${sourcePath} contains credential fields and was ignored. Remove secrets from the template.`
      };
    }

    if (!ALLOWED_FIELDS.has(field)) {
      return {
        sourcePath,
        warning: `${sourcePath} contains unsupported fields and was ignored. Remove unsupported entries from the template.`
      };
    }
  }

  const template: ConnectionProfileTemplate = {};
  try {
    for (const field of [
      'name',
      'serverUrl',
      'database',
      'apiBasePath',
      'apiVersionPath',
      'username',
      'proxyEndpoint'
    ] as const) {
      const value = readOptionalString(record, field, sourcePath);
      if (value !== undefined) {
        template[field] = value;
      }
    }
  } catch (error) {
    if (error instanceof ProfileTemplateValidationError) {
      return {
        sourcePath,
        warning: error.message
      };
    }
    throw error;
  }

  const authMode = record.authMode;
  if (authMode !== undefined) {
    if (authMode !== 'direct' && authMode !== 'proxy') {
      return {
        sourcePath,
        warning: `${sourcePath} has an invalid authMode. Use "direct" or "proxy".`
      };
    }
    template.authMode = authMode;
  }

  const locked = record.locked;
  if (locked !== undefined) {
    if (typeof locked !== 'boolean') {
      return {
        sourcePath,
        warning: `${sourcePath} has an invalid locked value. Use true or false.`
      };
    }
    template.locked = locked;
  }

  if (template.serverUrl) {
    const validation = validateServerUrl(template.serverUrl);
    if (!validation.ok) {
      return {
        sourcePath,
        warning: `${sourcePath} has an invalid serverUrl. Continue manually or fix the template.`
      };
    }
    template.serverUrl = validation.value;
  }

  if (template.database) {
    const validation = validateDatabaseName(template.database);
    if (!validation.ok) {
      return {
        sourcePath,
        warning: `${sourcePath} has an invalid database value. Continue manually or fix the template.`
      };
    }
    template.database = validation.value;
  }

  const hasPrefillFields = Object.keys(template).some((field) => field !== 'locked');
  if (!hasPrefillFields) {
    return {
      sourcePath,
      warning: `${sourcePath} does not include any profile fields to pre-fill. Continue manually or update the template.`
    };
  }

  return {
    template,
    sourcePath
  };
}

function readOptionalString(
  record: Record<string, unknown>,
  field: string,
  sourcePath: string
): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new ProfileTemplateValidationError(`${sourcePath} has an invalid ${field} value.`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

class ProfileTemplateValidationError extends Error {}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as Record<string, unknown>;
  return record.code === 'FileNotFound' || record.code === 'ENOENT';
}
