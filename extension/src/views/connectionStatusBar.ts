import * as vscode from 'vscode';

import type { ProfileStore } from '../services/profileStore';
import type { ConnectionProfile } from '../types/fm';

const STATUS_BAR_PRIORITY = 105;
const CLICK_COMMAND = 'filemakerDataApiTools.openConnectionMenu';

export interface ConnectionStatusModel {
  text: string;
  tooltip: string;
}

/**
 * Pure render: chosen so the labeling logic can be unit tested without VS
 * Code APIs (mirrors the pattern in offlineStatusBar.ts).
 */
export function computeConnectionStatus(
  activeProfile: Pick<ConnectionProfile, 'name' | 'database'> | undefined
): ConnectionStatusModel {
  if (!activeProfile) {
    return {
      text: '$(circle-outline) FileMaker: Not connected',
      tooltip: 'No active FileMaker profile. Click for actions.'
    };
  }
  return {
    text: `$(plug) FileMaker: ${activeProfile.name}`,
    tooltip: `Connected to ${activeProfile.name} (${activeProfile.database}). Click for actions.`
  };
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

  public constructor(private readonly profileStore: ProfileStore) {
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
    const activeProfileId = this.profileStore.getActiveProfileId();

    if (!activeProfileId) {
      this.applyModel(computeConnectionStatus(undefined));
      return;
    }

    // listProfiles is async; renderConnected handles the resolution. Until it
    // settles, show a placeholder so the user sees SOMETHING immediately
    // rather than a stale "not connected" label flashing during a connect.
    this.item.text = '$(plug) FileMaker: …';
    this.item.tooltip = 'Resolving active profile…';
    void this.renderConnected(activeProfileId);
  }

  private async renderConnected(profileId: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);
    this.applyModel(computeConnectionStatus(profile));
  }

  private applyModel(model: ConnectionStatusModel): void {
    this.item.text = model.text;
    this.item.tooltip = model.tooltip;
    this.item.backgroundColor = undefined;
  }

  public dispose(): void {
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
