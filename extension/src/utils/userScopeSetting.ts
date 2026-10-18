import type * as vscode from 'vscode';

/**
 * Reads a setting that WIDENS or REDIRECTS what the extension does (where a file is written,
 * and in later phases whether AI tools are on), so a repository must not be able to supply it.
 * Only the user's own `settings.json` value (`globalValue`) counts.
 *
 * This is a different reader from `readRestrictedSetting`, which treats remote values as part
 * of the baseline. In a dev container or Codespace a repository can ship remote-machine
 * settings (`globalRemoteValue`), so for these settings they are ignored too, together with
 * `workspaceValue`, `workspaceFolderValue` and `globalLocalValue`. If the configuration object
 * cannot say where a value came from, the answer is "not set", never `get()`, which merges
 * workspace values.
 */
export function readUserScopeValue<T>(
  configuration: Partial<Pick<vscode.WorkspaceConfiguration, 'inspect'>>,
  key: string,
  isValid: (value: unknown) => value is T
): T | undefined {
  if (typeof configuration.inspect !== 'function') {
    return undefined;
  }

  const inspected = configuration.inspect<unknown>(key);
  const value = inspected?.globalValue;
  return isValid(value) ? value : undefined;
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** A user-scope string setting; a blank string counts as unset. */
export function readUserScopeString(
  configuration: Partial<Pick<vscode.WorkspaceConfiguration, 'inspect'>>,
  key: string
): string | undefined {
  const value = readUserScopeValue(configuration, key, isString);
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}
