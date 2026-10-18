import * as vscode from 'vscode';

import type { SessionHealth } from '../services/fmClient';
import type { ProfileStore } from '../services/profileStore';
import type { ConnectionProfile } from '../types/fm';

const STATUS_BAR_PRIORITY = 105;
const CLICK_COMMAND = 'filemakerDataApiTools.openConnectionMenu';

export interface ConnectionStatusModel {
  text: string;
  tooltip: string;
  /** Draw attention (a problem with the connection). */
  warning?: boolean;
}

/** Where a profile's certificate trust stands, for the status line. */
type TlsFields = Pick<ConnectionProfile, 'allowSelfSigned' | 'pinnedCertSha256'>;

/**
 * Pure render: chosen so the labeling logic can be unit tested without VS
 * Code APIs (mirrors the pattern in offlineStatusBar.ts). `health` is what the
 * extension last learned from a real request; without it the item says only
 * that the profile is active, never that it is connected.
 */
export function computeConnectionStatus(
  activeProfile: (Pick<ConnectionProfile, 'name' | 'database'> & Partial<TlsFields>) | undefined,
  health?: SessionHealth,
  version?: string
): ConnectionStatusModel {
  const model = renderStatus(activeProfile, health);
  return version ? { ...model, tooltip: `${model.tooltip}\nFileMaker Data API Tools v${version}` } : model;
}

function renderStatus(
  activeProfile: (Pick<ConnectionProfile, 'name' | 'database'> & Partial<TlsFields>) | undefined,
  health?: SessionHealth
): ConnectionStatusModel {
  if (!activeProfile) {
    return {
      text: '$(circle-outline) FileMaker: Not connected',
      tooltip: 'No active FileMaker profile. Click for actions.'
    };
  }

  const name = activeProfile.name;
  const insecure =
    activeProfile.allowSelfSigned === true && !activeProfile.pinnedCertSha256
      ? ' This connection skips ALL certificate checks (an older setting): edit the profile and convert it to a trusted certificate.'
      : '';
  const marker = insecure ? ' $(warning)' : '';
  const place = `${name} (${activeProfile.database})`;

  switch (health?.state) {
    case 'connecting':
      return { text: `$(sync~spin) FileMaker: ${name}${marker}`, tooltip: `Connecting to ${place}…${insecure}` };
    case 'connected':
      return { text: `$(plug) FileMaker: ${name}${marker}`, tooltip: `Connected to ${place}. Click for actions.${insecure}`, warning: Boolean(insecure) };
    case 'auth-failed':
      return {
        text: `$(error) FileMaker: ${name} — sign-in failed`,
        tooltip: `${health.message ?? 'FileMaker rejected the account or password.'} Edit the connection to fix it, then run Connect.${insecure}`,
        warning: true
      };
    case 'certificate':
      return {
        text: `$(shield) FileMaker: ${name} — certificate problem`,
        tooltip: `${health.message ?? 'The server certificate was refused.'}${insecure}`,
        warning: true
      };
    case 'unreachable':
      return {
        text: `$(debug-disconnect) FileMaker: ${name} — unreachable`,
        tooltip: `${health.message ?? 'The server could not be reached.'}${insecure}`,
        warning: true
      };
    default:
      return {
        text: `$(circle-large-outline) FileMaker: ${name}${marker}`,
        tooltip: `${place} is the active profile. No request has been made in this window yet, so the connection has not been checked. Click for actions.${insecure}`,
        warning: Boolean(insecure)
      };
  }
}

/**
 * Persistent status-bar item that shows "FileMaker: <profile name>" when a
 * profile is active, and "FileMaker: Not connected" otherwise. The
 * connect-progress item (priority 110) overrides this briefly during connect
 * attempts; we sit just under that and above the offline badge (priority 100)
 * so the visual ordering reads: connect-progress > connection > offline > jobs.
 *
 * The previous wizard surface only ever showed a transient "Connected to X"
 * toast and a status-bar item that disposed itself in finally(). Across
 * reloads the user had no signal whether a session was alive — which led to
 * "I'll just run Connect again to be sure" cycles. This item is owned by the
 * extension host for the lifetime of the activation and is updated whenever
 * the active profile changes.
 */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private revision = 0;
  private disposed = false;
  private readonly unsubscribe: (() => void) | undefined;

  public constructor(
    private readonly profileStore: ProfileStore,
    private readonly health?: {
      getHealth(profileId: string): SessionHealth | undefined;
      onHealthChange(listener: (profileId: string, health: SessionHealth | undefined) => void): () => void;
    },
    private readonly version?: string
  ) {
    this.unsubscribe = health?.onHealthChange(() => this.refresh());
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      STATUS_BAR_PRIORITY
    );
    this.item.command = CLICK_COMMAND;
    this.item.show();
    this.refresh();
  }

  /**
   * Re-renders the item from the current ProfileStore state. Cheap; safe to
   * call from any command that changes the active profile (connect,
   * disconnect, remove, add).
   */
  public refresh(): void {
    if (this.disposed) return;
    const revision = ++this.revision;
    const activeProfileId = this.profileStore.getActiveProfileId();

    if (!activeProfileId) {
      this.applyModel(computeConnectionStatus(undefined, undefined, this.version));
      return;
    }

    // listProfiles is async; renderConnected handles the resolution. Until it
    // settles, show a placeholder so the user sees SOMETHING immediately
    // rather than a stale "not connected" label flashing during a connect.
    this.item.text = '$(plug) FileMaker: …';
    this.item.tooltip = 'Resolving active profile…';
    void this.renderConnected(activeProfileId, revision);
  }

  private async renderConnected(profileId: string, revision: number): Promise<void> {
    try {
      const profile = await this.profileStore.getProfile(profileId);
      if (!this.disposed && revision === this.revision) {
        this.applyModel(computeConnectionStatus(profile, profile ? this.health?.getHealth(profile.id) : undefined, this.version));
      }
    } catch {
      if (!this.disposed && revision === this.revision) {
        this.applyModel(computeConnectionStatus(undefined, undefined, this.version));
      }
    }
  }

  private applyModel(model: ConnectionStatusModel): void {
    this.item.text = model.text;
    this.item.tooltip = model.tooltip;
    this.item.backgroundColor = model.warning
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  public dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.item.dispose();
  }
}

/**
 * Pops a quick-pick with the contextual actions (Switch Profile / Disconnect /
 * Open Explorer / Add Profile). Exposed as a top-level command so the
 * status-bar item can wire it as its `command`.
 */
export async function showConnectionQuickPick(
  profileStore: ProfileStore
): Promise<void> {
  const activeProfileId = profileStore.getActiveProfileId();
  const profiles = await profileStore.listProfiles();

  type Pick = vscode.QuickPickItem & { action: string };
  const items: Pick[] = [];

  if (activeProfileId) {
    const active = profiles.find((p) => p.id === activeProfileId);
    items.push({
      label: '$(debug-disconnect) Disconnect',
      detail: active ? `From ${active.name}` : undefined,
      action: 'disconnect'
    });
  }
  if (profiles.length > 0) {
    items.push({
      label: activeProfileId ? '$(arrow-swap) Switch Profile…' : '$(plug) Connect…',
      detail: `${profiles.length} profile${profiles.length === 1 ? '' : 's'} available`,
      action: 'connect'
    });
  }
  items.push(
    {
      label: '$(list-tree) Open FileMaker Explorer',
      action: 'explorer'
    },
    {
      label: '$(add) Add Connection Profile…',
      action: 'addProfile'
    }
  );

  const choice = await vscode.window.showQuickPick(items, {
    title: 'FileMaker Connection',
    placeHolder: activeProfileId
      ? 'Active profile actions'
      : 'Not connected — choose an action'
  });
  if (!choice) return;

  switch (choice.action) {
    case 'disconnect':
      await vscode.commands.executeCommand('filemakerDataApiTools.disconnect');
      return;
    case 'connect':
      await vscode.commands.executeCommand('filemakerDataApiTools.connect');
      return;
    case 'explorer':
      await vscode.commands.executeCommand('filemakerExplorer.focus');
      return;
    case 'addProfile':
      await vscode.commands.executeCommand('filemakerDataApiTools.addConnectionProfile');
      return;
  }
}
