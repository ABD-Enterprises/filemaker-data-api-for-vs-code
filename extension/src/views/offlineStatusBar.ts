import * as vscode from 'vscode';

import type { OfflineModeService } from '../offline/offlineModeService';

const REFRESH_COMMAND = 'filemakerDataApiTools.refreshOfflineCache';
const POLL_INTERVAL_MS = 60_000;

export interface OfflineStatusBarOptions {
  /** Hours after which the newest cache entry is considered stale. <=0 disables the stale check. */
  getStaleHours: () => number;
  /** Command id invoked when the user clicks the status-bar item. */
  clickCommand?: string;
}

export interface OfflineCacheSnapshot {
  offlineMode: boolean;
  newestCapturedAt?: Date;
}

export interface OfflineStatusModel {
  visible: boolean;
  text: string;
  tooltip: string;
  stale: boolean;
}

/**
 * Pure render: chosen so the visibility/labeling logic can be unit tested without VS Code APIs.
 */
export function computeOfflineStatus(
  snapshot: OfflineCacheSnapshot,
  staleHours: number,
  now: Date = new Date()
): OfflineStatusModel {
  const ageHours =
    snapshot.newestCapturedAt !== undefined
      ? (now.getTime() - snapshot.newestCapturedAt.getTime()) / 3_600_000
      : undefined;
  const stale = staleHours > 0 && ageHours !== undefined && ageHours >= staleHours;

  if (!snapshot.offlineMode && !stale) {
    return { visible: false, text: '', tooltip: '', stale: false };
  }

  const ageLabel = ageHours !== undefined ? formatAge(ageHours) : 'no cache';
  const prefix = snapshot.offlineMode ? '$(database) Offline' : '$(warning) Cache stale';
  const text = `${prefix} · ${ageLabel}`;
  const tooltip = stale
    ? `FileMaker offline metadata cache is ${ageLabel} old. Click to refresh.`
    : 'FileMaker offline mode active. Click to refresh cache.';
  return { visible: true, text, tooltip, stale };
}

export function formatAge(hours: number): string {
  if (hours < 1) {
    const m = Math.max(1, Math.round(hours * 60));
    return `${m}m`;
  }
  if (hours < 24) {
    return `${Math.round(hours)}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

export class OfflineStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private staleWarningShown = false;

  public constructor(
    private readonly offlineModeService: OfflineModeService,
    private readonly options: OfflineStatusBarOptions
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = options.clickCommand ?? REFRESH_COMMAND;
  }

  public start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    const cfgWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('filemaker.offline')) {
        void this.refresh();
      }
    });
    this.disposables.push(cfgWatcher);
  }

  public async refresh(): Promise<void> {
    const offlineMode = this.offlineModeService.isOfflineModeEnabled();
    const entries = await this.offlineModeService.listCacheEntries().catch(() => []);

    const newest = entries.reduce<Date | undefined>((acc, entry) => {
      const t = Date.parse(entry.capturedAt);
      if (Number.isNaN(t)) {
        return acc;
      }
      const d = new Date(t);
      return !acc || d.getTime() > acc.getTime() ? d : acc;
    }, undefined);

    const status = computeOfflineStatus(
      { offlineMode, newestCapturedAt: newest },
      this.options.getStaleHours()
    );

    if (!status.visible) {
      this.item.hide();
      this.staleWarningShown = false;
      return;
    }

    this.item.text = status.text;
    this.item.tooltip = status.tooltip;
    this.item.backgroundColor = status.stale
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();

    if (status.stale && !this.staleWarningShown) {
      this.staleWarningShown = true;
      void vscode.window.showWarningMessage(
        `FileMaker offline metadata cache is older than ${this.options.getStaleHours()}h. Run "FileMaker: Refresh Cache" to update.`
      );
    }
    if (!status.stale) {
      this.staleWarningShown = false;
    }
  }

  public dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.disposables.forEach((d) => d.dispose());
    this.item.dispose();
  }
}
