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
export interface RestrictedReading {
  /** The value in effect. */
  value: boolean;
  /** The user's own value, or the default when the user set none. */
  baseline: boolean;
  baselineFrom: 'user' | 'default';
  /** What the workspace (or its folder) holds, if anything. */
  workspace: boolean | undefined;
  /** The workspace value is the restricted one, so it counts. */
  workspaceCounted: boolean;
}

/**
 * The reading behind {@link readRestrictedSetting}, with the pieces it was made from. The
 * Effective Settings view explains from this same result, so the explanation cannot drift from
 * the rule.
 */
export function inspectRestrictedSetting(
  configuration: Pick<vscode.WorkspaceConfiguration, 'get'> & Partial<Pick<vscode.WorkspaceConfiguration, 'inspect'>>,
  key: string,
  defaultValue: boolean,
  restrictedValue: boolean
): RestrictedReading {
  if (typeof configuration.inspect !== 'function') {
    const value = configuration.get<boolean>(key, defaultValue);
    return { value, baseline: value, baselineFrom: 'default', workspace: undefined, workspaceCounted: false };
  }

  const inspected = configuration.inspect<boolean>(key) as
    | (ReturnType<vscode.WorkspaceConfiguration['inspect']> & {
        globalLocalValue?: boolean;
        globalRemoteValue?: boolean;
      })
    | undefined;
  if (!inspected) {
    return {
      value: defaultValue,
      baseline: defaultValue,
      baselineFrom: 'default',
      workspace: undefined,
      workspaceCounted: false
    };
  }

  const userValue =
    (inspected.globalValue as boolean | undefined) ??
    inspected.globalRemoteValue ??
    inspected.globalLocalValue;
  const baseline = userValue ?? (inspected.defaultValue as boolean | undefined) ?? defaultValue;
  const workspace = (inspected.workspaceFolderValue ?? inspected.workspaceValue) as boolean | undefined;

  return {
    value: baseline === restrictedValue || workspace === restrictedValue ? restrictedValue : baseline,
    baseline,
    baselineFrom: userValue === undefined ? 'default' : 'user',
    workspace,
    workspaceCounted: workspace === restrictedValue
  };
}

export function readRestrictedSetting(
  configuration: Pick<vscode.WorkspaceConfiguration, 'get'> & Partial<Pick<vscode.WorkspaceConfiguration, 'inspect'>>,
  key: string,
  defaultValue: boolean,
  restrictedValue: boolean
): boolean {
  return inspectRestrictedSetting(configuration, key, defaultValue, restrictedValue).value;
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
