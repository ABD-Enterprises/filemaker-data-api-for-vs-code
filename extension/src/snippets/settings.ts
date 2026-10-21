import * as vscode from 'vscode';

/** An ordinary per-workspace setting: use VS Code's effective value, including in Restricted Mode. */
export function includeAuthByDefault(): boolean {
  return vscode.workspace.getConfiguration('filemaker').get<boolean>('snippets.includeAuthByDefault', false) === true;
}
