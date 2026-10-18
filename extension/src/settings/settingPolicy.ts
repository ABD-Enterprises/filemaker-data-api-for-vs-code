// Which kind each policy-relevant setting is, and a pure explanation of what is in effect and why.
// The EFFECTIVE value is always supplied by the caller from the reader that enforces the
// setting (readRestrictedSetting, readUserScopeValue, RoleGuard, SettingsService); this module
// only compares it with what each scope holds, so the explanation cannot disagree with the rule.

/** The role order a workspace may only lower. Shared with RoleGuard. */
export const ROLE_RANK: Record<'viewer' | 'developer' | 'admin', number> = { viewer: 0, developer: 1, admin: 2 };

export type SettingKind =
  /** `"scope": "application"`: only the user's own settings count. */
  | 'user-only'
  /** An on/off switch where a workspace may only move toward `restrictedValue`. */
  | 'stricter-bool'
  /** The enterprise role: a workspace may only lower it. */
  | 'stricter-role'
  /** A list where every scope adds to the others (a workspace can add, never remove). */
  | 'stricter-union'
  /** An ordinary setting a workspace may set (VS Code ignores some of them in Restricted Mode). */
  | 'workspace';

export interface PolicySetting {
  /** The key without the `filemaker.` prefix. */
  key: string;
  kind: SettingKind;
  /** For `stricter-bool`: the value that means "more restricted". */
  restrictedValue?: boolean;
  /** The code ignores this setting's workspace value in an untrusted workspace, whatever VS Code does. */
  forcedWhenUntrusted?: boolean;
}

export const POLICY_SETTINGS: readonly PolicySetting[] = [
  { key: 'offline.mode', kind: 'stricter-bool', restrictedValue: true },
  { key: 'features.batch.enabled', kind: 'stricter-bool', restrictedValue: false },
  { key: 'features.recordEdit.enabled', kind: 'stricter-bool', restrictedValue: false },
  { key: 'features.scriptRunner.enabled', kind: 'stricter-bool', restrictedValue: false },
  { key: 'features.ai.enabled', kind: 'stricter-bool', restrictedValue: false },
  { key: 'enterprise.mode', kind: 'stricter-bool', restrictedValue: true },
  { key: 'enterprise.role', kind: 'stricter-role' },
  { key: 'ai.hiddenFields', kind: 'stricter-union' },
  { key: 'ai.enabled', kind: 'user-only' },
  { key: 'ai.allowWrites', kind: 'user-only' },
  { key: 'ai.allowScripts', kind: 'user-only' },
  { key: 'ai.scriptAllowlist', kind: 'user-only' },
  { key: 'ai.readableLayouts', kind: 'user-only' },
  { key: 'ai.connection', kind: 'user-only' },
  { key: 'ai.contextPath', kind: 'user-only' },
  { key: 'ai.externalServer.enabled', kind: 'user-only' },
  { key: 'secrets.fallback', kind: 'user-only' },
  { key: 'export.neutralizeFormulas', kind: 'user-only' },
  { key: 'savedQueries.scope', kind: 'workspace' },
  { key: 'typegen.outputDir', kind: 'workspace' },
  { key: 'schema.snapshots.storage', kind: 'workspace', forcedWhenUntrusted: true },
  { key: 'batch.maxRecords', kind: 'workspace' },
  { key: 'batch.concurrency', kind: 'workspace' },
  { key: 'batch.dryRunDefault', kind: 'workspace' }
];

export const BADGE_USER_ONLY = '**User settings only.**';
export const BADGE_STRICTER = '**Workspace can only make this stricter.**';
export const BADGE_WORKSPACE = '**Per workspace.**';

export function badgeFor(kind: SettingKind | undefined): string {
  if (kind === 'user-only') {
    return BADGE_USER_ONLY;
  }
  return kind === 'stricter-bool' || kind === 'stricter-role' || kind === 'stricter-union'
    ? BADGE_STRICTER
    : BADGE_WORKSPACE;
}

export function policyFor(key: string): PolicySetting | undefined {
  return POLICY_SETTINGS.find((setting) => setting.key === key.replace(/^filemaker\./, ''));
}

export type SettingSource =
  | 'Default'
  | 'User'
  | 'Workspace'
  | 'Workspace Folder'
  | 'User and Workspace'
  | 'Enterprise file'
  | 'Restricted Mode';

/** What each scope holds for one setting. `workspaceFile` is read from `.vscode/settings.json` directly. */
export interface ScopeValues {
  default?: unknown;
  user?: unknown;
  workspace?: unknown;
  workspaceFolder?: unknown;
  /** VS Code drops application-scope keys from `inspect()` for a workspace, so the file is read instead. */
  workspaceFile?: unknown;
  /** What `.vscode/filemaker.config.json` asks for (enterprise mode and role only). */
  enterpriseFile?: unknown;
}

export interface ExplainInput {
  setting: PolicySetting;
  values: ScopeValues;
  /** The value the enforcing reader returned. */
  effective: unknown;
  trusted: boolean;
  /** The setting is in `capabilities.untrustedWorkspaces.restrictedConfigurations`. */
  restrictedInUntrusted: boolean;
}

export interface Explanation {
  key: string;
  kind: SettingKind;
  effective: unknown;
  source: SettingSource;
  userValue: unknown;
  /** The workspace folder value, else the workspace value, else the one found in the settings file. */
  workspaceValue: unknown;
  /** A workspace value exists and is not what is in effect. */
  ignored: boolean;
  /** The ignored value differs from what is in effect, so telling the user is worthwhile. */
  noticeWorthy: boolean;
  reason?: string;
  /** Opening the Workspace tab for this setting can change something. */
  workspaceMeaningful: boolean;
}

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const onOff = (value: unknown): string => (value === true ? 'on' : value === false ? 'off' : String(value));

export function explainSetting(input: ExplainInput): Explanation {
  const { setting, values, effective, trusted } = input;
  const id = `filemaker.${setting.key}`;
  const workspaceValue = values.workspaceFolder ?? values.workspace ?? values.workspaceFile;
  const hasWorkspace = workspaceValue !== undefined;
  const baseline = values.user ?? values.default;
  const baselineLabel = values.user !== undefined ? 'User' : 'default';
  const userSource: SettingSource = values.user !== undefined ? 'User' : 'Default';
  const workspaceSource: SettingSource = values.workspaceFolder !== undefined ? 'Workspace Folder' : 'Workspace';

  let source: SettingSource = userSource;
  let ignored = false;
  let reason: string | undefined;
  let workspaceMeaningful = true;

  switch (setting.kind) {
    case 'user-only': {
      workspaceMeaningful = false;
      if (hasWorkspace) {
        ignored = true;
        reason = `This setting only works in User settings; the workspace value (${JSON.stringify(workspaceValue)}) is ignored.`;
      }
      break;
    }
    case 'stricter-bool': {
      const restricted = setting.restrictedValue;
      if (values.enterpriseFile === restricted && baseline !== restricted) {
        source = 'Enterprise file';
      } else if (hasWorkspace && workspaceValue === restricted && baseline !== restricted) {
        source = workspaceSource;
      }
      if (hasWorkspace && workspaceValue !== effective) {
        ignored = true;
        reason =
          `This workspace sets ${setting.key} to ${String(workspaceValue)} but your ${baselineLabel} value is ` +
          `${String(baseline)}, and a workspace can only turn it ${restricted === true ? 'on' : 'off'}, ` +
          `so it stays ${onOff(effective)}.`;
      }
      break;
    }
    case 'stricter-role': {
      const rank = (role: unknown): number => ROLE_RANK[role as keyof typeof ROLE_RANK] ?? 1;
      if (!same(effective, baseline) && values.enterpriseFile === effective) {
        source = 'Enterprise file';
      } else if (!same(effective, baseline) && same(effective, workspaceValue)) {
        source = workspaceSource;
      }
      if (hasWorkspace && rank(workspaceValue) > rank(effective)) {
        ignored = true;
        reason =
          `This workspace sets ${setting.key} to ${String(workspaceValue)} but your ${baselineLabel} value is ` +
          `${String(baseline)}, and a workspace can only lower the role, so it stays ${String(effective)}.`;
      }
      break;
    }
    case 'stricter-union': {
      source = hasWorkspace ? 'User and Workspace' : userSource;
      break;
    }
    case 'workspace': {
      const untrustedBlocked =
        !trusted && hasWorkspace && (input.restrictedInUntrusted || setting.forcedWhenUntrusted === true);
      if (untrustedBlocked) {
        source = 'Restricted Mode';
        ignored = true;
        reason =
          `This workspace is in Restricted Mode, so its value for ${setting.key} is not used until you trust ` +
          `the folder.`;
      } else if (hasWorkspace) {
        source = workspaceSource;
      }
      break;
    }
  }

  return {
    key: id,
    kind: setting.kind,
    effective,
    source,
    userValue: values.user,
    workspaceValue,
    ignored,
    noticeWorthy: ignored && !same(workspaceValue, effective),
    ...(reason ? { reason } : {}),
    workspaceMeaningful
  };
}

// --- one notification per ignored setting per workspace --------------------------------------

export interface NoticeState {
  /** Setting keys already announced in this workspace. */
  seen: string[];
  /** The user chose "Don't show again for this workspace". */
  muted: boolean;
}

export const EMPTY_NOTICE_STATE: NoticeState = { seen: [], muted: false };

/** Which ignored settings to announce now, and the state to store. Announcing marks them seen. */
export function pickNotices(
  explanations: readonly Explanation[],
  state: NoticeState
): { show: Explanation[]; next: NoticeState } {
  if (state.muted) {
    return { show: [], next: state };
  }
  const show = explanations.filter((entry) => entry.noticeWorthy && !state.seen.includes(entry.key));
  return show.length === 0
    ? { show, next: state }
    : { show, next: { ...state, seen: [...state.seen, ...show.map((entry) => entry.key)] } };
}

/** The text of the one notification for a batch of ignored settings. */
export function noticeMessage(show: readonly Explanation[]): string {
  const [first] = show;
  if (first && show.length === 1) {
    return first.reason ?? `This workspace sets ${first.key} but it is ignored.`;
  }
  return `This workspace sets ${show.length} settings that are ignored: ${show.map((entry) => entry.key).join(', ')}.`;
}

// --- reading `.vscode/settings.json` -----------------------------------------------------------

/** Removes comments and trailing commas from JSONC, leaving strings alone. */
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
    } else {
      out += ch;
    }
  }
  return removeTrailingCommas(out);
}

function removeTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
      // trailing comma: drop it
    } else {
      out += ch;
    }
  }
  return out;
}

/** The `filemaker.*` entries of a settings file, keyed without the prefix. Unparseable text gives `{}`. */
export function parseFilemakerSettings(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stripJsonc(text)) as unknown;
    const result: Record<string, unknown> = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('filemaker.')) {
          result[key.slice('filemaker.'.length)] = value;
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}
