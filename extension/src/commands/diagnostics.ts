import * as vscode from 'vscode';

import { DiagnosticsDashboardPanel } from '../diagnostics/diagnosticsDashboard';
import { NetworkLogPanel } from '../diagnostics/networkLogPanel';
import type { MetricsStore } from '../diagnostics/metricsStore';
import type { NetworkLogStore } from '../diagnostics/networkLogStore';
import type { HistoryStore } from '../services/historyStore';

interface RegisterDiagnosticsCommandDeps {
  metricsStore: MetricsStore;
  historyStore: HistoryStore;
  networkLogStore: NetworkLogStore;
}

export function registerDiagnosticsCommands(
  deps: RegisterDiagnosticsCommandDeps
): vscode.Disposable[] {
  const { metricsStore, historyStore, networkLogStore } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.openDiagnosticsDashboard', () => {
      DiagnosticsDashboardPanel.createOrShow(metricsStore, historyStore);
    }),
    vscode.commands.registerCommand('filemakerDataApiTools.openNetworkLog', () => {
      NetworkLogPanel.createOrShow(networkLogStore);
    })
  ];
}
