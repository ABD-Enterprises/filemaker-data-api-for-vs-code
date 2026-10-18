import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { basename, join } from 'path';
import { pathToFileURL } from 'url';

import * as vscode from 'vscode';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { ProfileStore } from '../services/profileStore';
import type { FileMakerPlugin, FileMakerPluginApi, PluginModuleExports } from './pluginTypes';

interface PluginRegistryOptions {
  internalPlugins?: FileMakerPlugin[];
  getWorkspaceRoot?: () => string | undefined;
  isWorkspaceTrusted?: () => boolean;
  readDir?: (path: string) => Promise<string[]>;
  importModule?: (absolutePath: string) => Promise<PluginModuleExports>;
  readFileBytes?: (absolutePath: string) => Promise<Uint8Array>;
  /** Where approvals are remembered between sessions (the extension passes globalState). */
  approvalState?: Pick<vscode.Memento, 'get' | 'update'>;
  /** Asks the user whether a workspace plugin may run. Defaults to a modal dialog. */
  askConsent?: (request: { fileName: string; workspaceRoot: string }) => Promise<boolean>;
}

interface ActivePluginRecord {
  id: string;
  name: string;
  source: 'internal' | 'workspace';
  commandCount: number;
  treeProviderCount: number;
}

const WORKSPACE_PLUGIN_RELATIVE_DIR = '.vscode/filemaker-plugins';
const APPROVED_PLUGINS_KEY = 'filemakerDataApiTools.approvedWorkspacePlugins';

export class PluginRegistry implements vscode.Disposable {
  private readonly internalPlugins: FileMakerPlugin[];
  private readonly getWorkspaceRoot: () => string | undefined;
  private readonly isWorkspaceTrusted: () => boolean;
  private readonly readDir: (path: string) => Promise<string[]>;
  private readonly importModule: (absolutePath: string) => Promise<PluginModuleExports>;
  private readonly readFileBytes: (absolutePath: string) => Promise<Uint8Array>;
  private readonly approvalState: Pick<vscode.Memento, 'get' | 'update'>;
  private readonly askConsent: (request: { fileName: string; workspaceRoot: string }) => Promise<boolean>;

  private readonly disposables: vscode.Disposable[] = [];
  private activePlugins: ActivePluginRecord[] = [];

  public constructor(
    private readonly profileStore: ProfileStore,
    private readonly fmClient: FMClient,
    private readonly roleGuard: RoleGuard,
    private readonly logger: Pick<
      {
        info: (message: string, meta?: unknown) => void;
        warn: (message: string, meta?: unknown) => void;
        error: (message: string, meta?: unknown) => void;
      },
      'info' | 'warn' | 'error'
    >,
    options?: PluginRegistryOptions
  ) {
    this.internalPlugins = options?.internalPlugins ?? [];
    this.getWorkspaceRoot = options?.getWorkspaceRoot ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    this.isWorkspaceTrusted = options?.isWorkspaceTrusted ?? (() => vscode.workspace.isTrusted);
    this.readDir = options?.readDir ?? ((path) => readdir(path));
    this.readFileBytes = options?.readFileBytes ?? ((path) => readFile(path));
    this.approvalState = options?.approvalState ?? createInMemoryApprovalState();
    this.askConsent =
      options?.askConsent ??
      (async ({ fileName, workspaceRoot }) => {
        const answer = await vscode.window.showWarningMessage(
          `Run the plugin "${fileName}" from this workspace?\n\n${workspaceRoot}\n\nA plugin runs with the same access as this extension: your saved FileMaker connections and sessions. Only run plugins you trust.`,
          { modal: true },
          'Run plugin'
        );
        return answer === 'Run plugin';
      });
    this.importModule =
      options?.importModule ??
      (async (absolutePath: string) => {
        return (await import(pathToFileURL(absolutePath).toString())) as PluginModuleExports;
      });
  }

  public async reload(): Promise<void> {
    this.disposePluginResources();

    const plugins: Array<{ plugin: FileMakerPlugin; source: ActivePluginRecord['source'] }> = [];

    for (const plugin of this.internalPlugins) {
      plugins.push({ plugin, source: 'internal' });
    }

    if (this.isWorkspaceTrusted()) {
      const guard = this.roleGuard.getFeatureGuard('pluginInstall');
      if (guard.allowed) {
        const workspacePlugins = await this.loadWorkspacePlugins();
        for (const plugin of workspacePlugins) {
          plugins.push({ plugin, source: 'workspace' });
        }
      } else {
        this.logger.info('Workspace plugins skipped by enterprise policy.', {
          reason: guard.reason
        });
      }
    }

    const api = this.createSafeApi();
    const active: ActivePluginRecord[] = [];

    for (const entry of plugins) {
      const plugin = entry.plugin;

      try {
        await plugin.activate(api);

        const commandDisposables: vscode.Disposable[] = [];
        const commands = plugin.commands ?? [];

        for (const command of commands) {
          const commandId = `filemakerDataApiTools.plugin.${plugin.id}.${command.id}`;

          const disposable = vscode.commands.registerCommand(commandId, async () => {
            if (command.requiresAdmin) {
              const allowed = await this.roleGuard.assertFeature(
                'pluginInstall',
                `Plugin command "${command.title}"`
              );

              if (!allowed) {
                return;
              }
            }

            await command.run(api);
          });

          commandDisposables.push(disposable);
        }

        const treeDisposables = (plugin.treeProviders ?? []).map((provider) =>
          vscode.window.registerTreeDataProvider(provider.id, provider.provider)
        );

        this.disposables.push(...commandDisposables, ...treeDisposables);

        active.push({
          id: plugin.id,
          name: plugin.name,
          source: entry.source,
          commandCount: commands.length,
          treeProviderCount: (plugin.treeProviders ?? []).length
        });
      } catch (error) {
        this.logger.error('Plugin activation failed.', {
          pluginId: plugin.id,
          error
        });
      }
    }

    this.activePlugins = active;

    this.logger.info('Plugin registry reloaded.', {
      activePlugins: active.length
    });
  }

  public listActivePlugins(): ActivePluginRecord[] {
    return [...this.activePlugins].sort((left, right) => left.name.localeCompare(right.name));
  }

  public dispose(): void {
    this.disposePluginResources();
  }

  private disposePluginResources(): void {
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }

    this.activePlugins = [];
  }

  private createSafeApi(): FileMakerPluginApi {
    return {
      log: (level, message, meta) => {
        if (level === 'info') {
          this.logger.info(message, meta);
          return;
        }

        if (level === 'warn') {
          this.logger.warn(message, meta);
          return;
        }

        this.logger.error(message, meta);
      },
      showInformationMessage: (message) => vscode.window.showInformationMessage(message),
      executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
      listProfiles: async () => {
        const profiles = await this.profileStore.listProfiles();
        return profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          database: profile.database,
          authMode: profile.authMode
        }));
      },
      listLayouts: async (profileId) => {
        const profile = await this.profileStore.getProfile(profileId);
        if (!profile) {
          throw new Error(`Profile ${profileId} not found.`);
        }

        return this.fmClient.listLayouts(profile);
      },
      getLayoutMetadata: async (profileId, layout) => {
        const profile = await this.profileStore.getProfile(profileId);
        if (!profile) {
          throw new Error(`Profile ${profileId} not found.`);
        }

        return this.fmClient.getLayoutMetadata(profile, layout);
      }
    };
  }

  /**
   * A plugin file arrives with the repository, so it only runs once the user has said yes to
   * this exact content in this workspace. Changing the file asks again.
   */
  private async isApprovedToRun(workspaceRoot: string, absolutePath: string): Promise<boolean> {
    const fileName = basename(absolutePath);
    const hash = createHash('sha256').update(await this.readFileBytes(absolutePath)).digest('hex');
    const key = `${workspaceRoot}|${fileName}`;
    const approved = this.approvalState.get<Record<string, string>>(APPROVED_PLUGINS_KEY, {}) ?? {};

    if (approved[key] === hash) {
      return true;
    }

    if (!(await this.askConsent({ fileName, workspaceRoot }))) {
      return false;
    }

    await this.approvalState.update(APPROVED_PLUGINS_KEY, { ...approved, [key]: hash });
    return true;
  }

  private async loadWorkspacePlugins(): Promise<FileMakerPlugin[]> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return [];
    }

    const pluginDir = join(root, WORKSPACE_PLUGIN_RELATIVE_DIR);
    let files: string[];

    try {
      files = await this.readDir(pluginDir);
    } catch {
      return [];
    }

    const candidates = files
      .filter((file) => /\.(js|cjs|mjs)$/i.test(file))
      .map((file) => join(pluginDir, file));

    const loaded: FileMakerPlugin[] = [];

    for (const absolutePath of candidates) {
      try {
        if (!(await this.isApprovedToRun(root, absolutePath))) {
          this.logger.info('Workspace plugin skipped: not approved to run.', { absolutePath });
          continue;
        }

        const module = await this.importModule(absolutePath);
        const plugin = module.default ?? module.plugin;
        if (!plugin) {
          continue;
        }

        if (!plugin.id || !plugin.name || typeof plugin.activate !== 'function') {
          this.logger.warn('Skipping plugin with invalid shape.', { absolutePath });
          continue;
        }

        loaded.push(plugin);
      } catch (error) {
        this.logger.warn('Failed to load workspace plugin.', {
          absolutePath,
          error
        });
      }
    }

    return loaded;
  }
}

function createInMemoryApprovalState(): Pick<vscode.Memento, 'get' | 'update'> {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (values.has(key) ? (values.get(key) as T) : (defaultValue as T)),
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    }
  };
}
