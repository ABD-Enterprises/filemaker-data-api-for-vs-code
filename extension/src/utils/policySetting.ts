import type * as vscode from 'vscode';

export type ConfigurationReader = Pick<vscode.WorkspaceConfiguration, 'get'> &
  Partial<Pick<vscode.WorkspaceConfiguration, 'inspect'>>;

/**
 * Reads an on/off setting that restricts what the extension may do (offline mode, or a
 * feature switch such as `features.scriptRunner.enabled`), where a repository's own
 * `.vscode/settings.json` may make things stricter but must never loosen them.
 *
 * The baseline is the user's setting, or the default. A workspace value only counts when it
 * is the restricted one. So a user who turned offline mode on, or a feature off, keeps it
 * that way whatever the repository ships.
 *
 * @param restrictedValue the value that means "restricted" (`true` for offline mode,
 *   `false` for an `enabled` switch).
 */
export function readRestrictedSetting(
  configuration: Pick<vscode.WorkspaceConfiguration, 'get'> & Partial<Pick<vscode.WorkspaceConfiguration, 'inspect'>>,
  key: string,
  defaultValue: boolean,
  restrictedValue: boolean
): boolean {
  if (typeof configuration.inspect !== 'function') {
    return configuration.get<boolean>(key, defaultValue);
  }

  const inspected = configuration.inspect<boolean>(key) as
    | (ReturnType<vscode.WorkspaceConfiguration['inspect']> & {
        globalLocalValue?: boolean;
        globalRemoteValue?: boolean;
      })
    | undefined;
  if (!inspected) {
    return defaultValue;
  }

  const baseline =
    (inspected.globalValue as boolean | undefined) ??
    inspected.globalRemoteValue ??
    inspected.globalLocalValue ??
    (inspected.defaultValue as boolean | undefined) ??
    defaultValue;
  const workspace = (inspected.workspaceFolderValue ?? inspected.workspaceValue) as boolean | undefined;

  return baseline === restrictedValue || workspace === restrictedValue ? restrictedValue : baseline;
}

/** `filemaker.offline.mode`: a workspace may switch it on, never off. */
export function isOfflineModeOn(configuration: Parameters<typeof readRestrictedSetting>[0]): boolean {
  return readRestrictedSetting(configuration, 'offline.mode', false, true);
}

/** A `filemaker.features.*.enabled` switch: a workspace may switch it off, never on. */
export function isFeatureEnabled(
  configuration: Parameters<typeof readRestrictedSetting>[0],
  key: string
): boolean {
  return readRestrictedSetting(configuration, key, true, false);
}
