import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { readAiSettings } from '../ai/aiSettings';
import type { RoleGuard } from '../enterprise/roleGuard';
import type { SettingsService } from '../services/settingsService';
import { buildWebviewCsp, createNonce } from '../webviews/common/csp';
import { readRestrictedSetting } from '../utils/policySetting';
import { readUserScopeValue } from '../utils/userScopeSetting';
import {
  EMPTY_NOTICE_STATE,
  POLICY_SETTINGS,
  explainSetting,
  noticeMessage,
  parseFilemakerSettings,
  pickNotices,
  type Explanation,
  type NoticeState,
  type PolicySetting
} from './settingPolicy';

export const SHOW_EFFECTIVE_SETTINGS = 'filemakerDataApiTools.showEffectiveSettings';
const NOTICE_STATE_KEY = 'filemaker.settingsNoticeState';
const OPEN_VIEW = 'Open Effective Settings';
const MUTE = "Don't show again for this workspace";

interface Dependencies {
  context: vscode.ExtensionContext;
  roleGuard: RoleGuard;
  settingsService: SettingsService;
}

/** `.vscode/settings.json` values for `filemaker.*`, first folder that sets a key wins. */
async function readWorkspaceFileValues(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const text = await readFile(path.join(folder.uri.fsPath, '.vscode', 'settings.json'), 'utf8');
      for (const [key, value] of Object.entries(parseFilemakerSettings(text))) {
        if (!(key in result)) {
          result[key] = value;
        }
      }
    } catch {
      // No settings file in this folder.
    }
  }
  return result;
}

function effectiveValue(
  setting: PolicySetting,
  config: vscode.WorkspaceConfiguration,
  inspected: ReturnType<vscode.WorkspaceConfiguration['inspect']>,
  deps: Dependencies,
  enterpriseFile: ReturnType<RoleGuard['getEnterpriseFileSettings']>
): unknown {
  const fallback = inspected?.defaultValue;
  switch (setting.key) {
    case 'enterprise.mode':
      return (
        readRestrictedSetting(config, setting.key, false, true) || enterpriseFile.enterpriseMode === true
      );
    case 'enterprise.role':
      return deps.roleGuard.getRole();
    case 'ai.hiddenFields':
      return readAiSettings(config).hiddenFields;
    case 'savedQueries.scope':
      return deps.settingsService.getSavedQueriesScope();
    case 'typegen.outputDir':
      return deps.settingsService.getTypegenOutputDir();
    case 'schema.snapshots.storage':
      return deps.settingsService.getSchemaSnapshotsStorage();
    default:
  }
  if (setting.kind === 'stricter-bool') {
    return readRestrictedSetting(config, setting.key, fallback === true, setting.restrictedValue === true);
  }
  if (setting.kind === 'user-only') {
    const userValue = readUserScopeValue(config, setting.key, (value): value is unknown => value !== undefined);
    return userValue ?? fallback;
  }
  return config.get(setting.key, fallback);
}

/** Every policy-relevant setting with its explanation, computed by the readers that enforce it. */
export async function collectExplanations(deps: Dependencies): Promise<Explanation[]> {
  const config = vscode.workspace.getConfiguration('filemaker');
  const manifest = deps.context.extension.packageJSON as {
    capabilities?: { untrustedWorkspaces?: { restrictedConfigurations?: string[] } };
  };
  const restricted = new Set(manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? []);
  const fileValues = await readWorkspaceFileValues();
  const enterpriseFile = deps.roleGuard.getEnterpriseFileSettings();

  return POLICY_SETTINGS.map((setting) => {
    const inspected = config.inspect(setting.key);
    const enterpriseValue =
      setting.key === 'enterprise.mode'
        ? enterpriseFile.enterpriseMode
        : setting.key === 'enterprise.role'
          ? enterpriseFile.role
          : undefined;
    return explainSetting({
      setting,
      values: {
        default: inspected?.defaultValue,
        user: inspected?.globalValue,
        workspace: inspected?.workspaceValue,
        workspaceFolder: inspected?.workspaceFolderValue,
        workspaceFile: fileValues[setting.key],
        enterpriseFile: enterpriseValue
      },
      effective: effectiveValue(setting, config, inspected, deps, enterpriseFile),
      trusted: vscode.workspace.isTrusted,
      restrictedInUntrusted: restricted.has(`filemaker.${setting.key}`)
    });
  });
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const show = (value: unknown): string => (value === undefined ? '' : JSON.stringify(value));

export function renderEffectiveSettingsHtml(
  rows: readonly Explanation[],
  csp: string,
  nonce: string
): string {
  const body = rows
    .map((row) => {
      const key = escapeHtml(row.key);
      const buttons =
        `<button data-open="user" data-key="${key}">Open User Settings</button>` +
        (row.workspaceMeaningful
          ? `<button data-open="workspace" data-key="${key}">Open Workspace Settings</button>`
          : '');
      const note = row.reason
        ? `<div class="${row.ignored ? 'ignored' : ''}">${escapeHtml(row.reason)}</div>`
        : '';
      return (
        `<tr><td><code>${key}</code></td><td><code>${escapeHtml(show(row.effective))}</code></td>` +
        `<td>${escapeHtml(row.source)}</td><td><code>${escapeHtml(show(row.userValue))}</code></td>` +
        `<td><code>${escapeHtml(show(row.workspaceValue))}</code></td><td>${note}${buttons}</td></tr>`
      );
    })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>FileMaker Effective Settings</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--vscode-panel-border, #8884); padding: 6px 8px; text-align: left; vertical-align: top; font-size: 12px; }
  .ignored { color: var(--vscode-editorWarning-foreground, #b58900); margin-bottom: 4px; }
  button { margin: 2px 4px 2px 0; }
  .muted { color: var(--vscode-descriptionForeground); }
</style></head>
<body>
<h2>Effective settings</h2>
<p class="muted">What is in effect right now, where it comes from, and why a workspace value is ignored. A workspace can only make restricted settings stricter, and some settings only work in User settings. Read-only.</p>
<table><thead><tr><th>Setting</th><th>In effect</th><th>Comes from</th><th>User value</th><th>Workspace value</th><th>Notes</th></tr></thead>
<tbody>
${body}
</tbody></table>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const el = event.target.closest('button[data-open]');
    if (el) { vscode.postMessage({ type: 'open', target: el.dataset.open, key: el.dataset.key }); }
  });
</script>
</body></html>`;
}

/** The commands that open the Settings editor on the User or Workspace tab (VS Code 1.142 checked). */
export async function openSettingsTab(target: 'user' | 'workspace', key: string): Promise<void> {
  await vscode.commands.executeCommand(
    target === 'user' ? 'workbench.action.openGlobalSettings' : 'workbench.action.openWorkspaceSettings',
    { query: `@id:${key}` }
  );
}

let panel: vscode.WebviewPanel | undefined;

async function showPanel(deps: Dependencies): Promise<void> {
  const rows = await collectExplanations(deps);
  if (!panel) {
    panel = vscode.window.createWebviewPanel('filemakerEffectiveSettings', 'FileMaker Effective Settings', vscode.ViewColumn.Active, {
      enableScripts: true
    });
    panel.onDidDispose(() => {
      panel = undefined;
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      const data = message as { type?: unknown; target?: unknown; key?: unknown };
      const known = POLICY_SETTINGS.some((setting) => `filemaker.${setting.key}` === data.key);
      if (data.type === 'open' && (data.target === 'user' || data.target === 'workspace') && known) {
        void openSettingsTab(data.target, data.key as string);
      }
    });
  } else {
    panel.reveal();
  }
  const nonce = createNonce();
  const csp = buildWebviewCsp(panel.webview, { nonce, allowInlineStyleWithNonce: true });
  panel.webview.html = renderEffectiveSettingsHtml(rows, csp, nonce);
}

async function announceIgnored(deps: Dependencies): Promise<void> {
  const state = deps.context.workspaceState.get<NoticeState>(NOTICE_STATE_KEY, EMPTY_NOTICE_STATE);
  const { show: toShow, next } = pickNotices(await collectExplanations(deps), state);
  if (toShow.length === 0) {
    return;
  }
  await deps.context.workspaceState.update(NOTICE_STATE_KEY, next);
  const choice = await vscode.window.showInformationMessage(noticeMessage(toShow), OPEN_VIEW, MUTE);
  if (choice === OPEN_VIEW) {
    await showPanel(deps);
  } else if (choice === MUTE) {
    await deps.context.workspaceState.update(NOTICE_STATE_KEY, { ...next, muted: true });
  }
}

export function registerEffectiveSettings(deps: Dependencies): vscode.Disposable[] {
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void announceIgnored(deps).catch(() => undefined);
    }, 750);
    timer.unref();
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/settings.json');
  schedule();
  return [
    vscode.commands.registerCommand(SHOW_EFFECTIVE_SETTINGS, () => showPanel(deps)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('filemaker')) {
        schedule();
      }
    }),
    watcher,
    watcher.onDidChange(schedule),
    watcher.onDidCreate(schedule),
    { dispose: () => clearTimeout(timer) }
  ];
}
