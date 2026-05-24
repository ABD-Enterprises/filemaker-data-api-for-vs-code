import * as vscode from 'vscode';

import type { CircuitBreakerRegistry, RegistryEntry } from '../performance/circuitBreakerRegistry';

type CircuitBreakerRegistryReader =
  | Pick<CircuitBreakerRegistry, 'list'>
  | {
      list: () => RegistryEntry[] | Promise<RegistryEntry[]>;
    };

export interface CircuitBreakerCommandsDeps {
  registry: CircuitBreakerRegistryReader;
}

export function registerCircuitBreakerCommands(
  deps: CircuitBreakerCommandsDeps
): vscode.Disposable[] {
  const showStatus = vscode.commands.registerCommand(
    'filemakerDataApiTools.showCircuitBreakerStatus',
    async () => {
      const [entries, { renderCircuitBreakerStatus }] = await Promise.all([
        deps.registry.list(),
        import('../performance/circuitBreakerRegistry')
      ]);
      const content = renderCircuitBreakerStatus(entries);
      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  );

  return [showStatus];
}
