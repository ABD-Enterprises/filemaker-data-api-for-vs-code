import * as vscode from 'vscode';

import { DiagnosticsDashboardPanel } from '../diagnostics/diagnosticsDashboard';
import type { MetricsStore } from '../diagnostics/metricsStore';
import type { HistoryStore } from '../services/historyStore';

interface RegisterDiagnosticsCommandDeps {
  metricsStore: MetricsStore;
  historyStore: HistoryStore;
}

export function registerDiagnosticsCommands(deps: RegisterDiagnosticsCommandDeps): vscode.Disposable[] {
  const { metricsStore, historyStore } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.openDiagnosticsDashboard', () => {
      DiagnosticsDashboardPanel.createOrShow(metricsStore, historyStore);
    })
  ];
}
