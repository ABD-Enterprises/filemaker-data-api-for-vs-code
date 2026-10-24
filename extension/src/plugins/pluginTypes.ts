import type * as vscode from 'vscode';

import type { ConnectionProfile } from '../types/fm';

export interface PluginCommand {
  id: string;
  title: string;
  run: (api: FileMakerPluginApi) => Promise<void>;
  requiresAdmin?: boolean;
}

export interface PluginTreeProvider {
  id: string;
  label: string;
  provider: vscode.TreeDataProvider<vscode.TreeItem>;
}

/**
 * Plugin contract for FileMaker Data API Tools extensions.
 *
 * Security model:
 * - Plugins are loaded only from trusted workspaces (workspace trust required)
 * - Plugins receive a sandboxed API that does NOT expose SecretStorage or credentials
 * - Plugins cannot access other plugins' state or the extension's internal services
 * - Plugin activation failures are caught and logged without affecting the extension
 * - All plugin-registered commands run within the extension's role guard context
 */
export interface FileMakerPlugin {
  id: string;
  name: string;
  activate: (api: FileMakerPluginApi) => Promise<void> | void;
  commands?: PluginCommand[];
  treeProviders?: PluginTreeProvider[];
}

export interface FileMakerPluginApi {
  log: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void;
  showInformationMessage: (message: string) => Thenable<string | undefined>;
  executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
  listProfiles: () => Promise<Array<Pick<ConnectionProfile, 'id' | 'name' | 'database' | 'authMode'>>>;
  listLayouts: (profileId: string) => Promise<string[]>;
  getLayoutMetadata: (profileId: string, layout: string) => Promise<Record<string, unknown>>;
}

export interface PluginModuleExports {
  default?: FileMakerPlugin;
  plugin?: FileMakerPlugin;
}
