import type * as vscode from 'vscode';

/**
 * Reads a setting that WIDENS or REDIRECTS what the extension does (where a file is written,
 * and in later phases whether AI tools are on), so a repository must not be able to supply it.
 *
 * Two things together keep a repository out: the setting is declared `"scope": "application"`
 * in package.json, so VS Code does not accept it from workspace settings, and this reader
 * returns only `globalValue` (the user's own `settings.json`), never `get()`, which merges
 * workspace values. This reader does not itself filter remote-machine values: in a dev
 * container the application-scope declaration is what stops a repository from setting it.
 * If the configuration object cannot say where a value came from, the answer is "not set".
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
