import type * as vscode from 'vscode';

import { isFeatureEnabled } from '../utils/policySetting';
import { readUserScopeValue } from '../utils/userScopeSetting';

type Configuration = Partial<Pick<vscode.WorkspaceConfiguration, 'inspect'>> &
  Pick<vscode.WorkspaceConfiguration, 'get'>;

/**
 * What the user allows AI tools to do. Every widening setting comes from the user's own
 * settings only (see userScopeSetting.ts); the settings are also declared
 * `"scope": "application"` in package.json.
 */
export interface AiSettings {
  enabled: boolean;
  allowWrites: boolean;
  allowScripts: boolean;
  /** Profile id -> exact script names that may be run. */
  scriptAllowlist: Record<string, string[]>;
  /** Profile id -> layout names that may be read without asking. */
  readableLayouts: Record<string, string[]>;
  /** Only ever grows when a workspace adds to it. */
  hiddenFields: string[];
  /** The profile id AI tools use. Never taken from a workspace file. */
  connection: string | undefined;
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isString = (value: unknown): value is string => typeof value === 'string';

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isStringListMap(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isStringList)
  );
}

export function readAiSettings(configuration: Configuration): AiSettings {
  const flag = (key: string): boolean => readUserScopeValue(configuration, key, isBoolean) === true;
  const connection = readUserScopeValue(configuration, 'ai.connection', isString)?.trim();

  return {
    enabled: flag('ai.enabled'),
    allowWrites: flag('ai.allowWrites'),
    allowScripts: flag('ai.allowScripts'),
    scriptAllowlist: sanitizeMap(readUserScopeValue(configuration, 'ai.scriptAllowlist', isStringListMap)),
    readableLayouts: sanitizeMap(readUserScopeValue(configuration, 'ai.readableLayouts', isStringListMap)),
    hiddenFields: readHiddenFields(configuration),
    connection: connection ? connection : undefined
  };
}

function sanitizeMap(map: Record<string, string[]> | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [key, values] of Object.entries(map ?? {})) {
    result[key] = values;
  }
  return result;
}

/**
 * `filemaker.ai.hiddenFields` NARROWS what a model can see, so unlike the widening settings it
 * is the union of every scope: a workspace may add names, never remove one the user set.
 */
function readHiddenFields(configuration: Configuration): string[] {
  const inspected =
    typeof configuration.inspect === 'function'
      ? (configuration.inspect<unknown>('ai.hiddenFields') as Record<string, unknown> | undefined)
      : undefined;
  if (!inspected) {
    return [];
  }

  const scopes = [
    'globalValue',
    'globalLocalValue',
    'globalRemoteValue',
    'workspaceValue',
    'workspaceFolderValue'
  ];
  const names = new Set<string>();
  for (const scope of scopes) {
    const value = inspected[scope];
    if (isStringList(value)) {
      for (const name of value) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * `filemaker.features.ai.enabled`: a workspace or enterprise file may switch AI off, never
 * on. Same reader as the other feature switches.
 */
export function isAiFeatureSwitchOn(configuration: Configuration): boolean {
  return isFeatureEnabled(configuration, 'features.ai.enabled');
}
