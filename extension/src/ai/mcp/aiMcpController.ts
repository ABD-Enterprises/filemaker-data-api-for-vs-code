import { rmSync } from 'fs';
import { dirname, isAbsolute } from 'path';

import * as vscode from 'vscode';

import { AiMcpServer, type McpToolCore } from './aiMcpServer';
import { newToken } from './auth';
import { DISCOVERY_VERSION, discoveryFileName, ensureOwnerOnlyDirectory, removeDiscovery, scanDiscovery, writeDiscovery, type Liveness } from './discovery';
import { discoveryDirectory, installShim } from './mcpConfig';
import { getProcessStartTime } from './processInfo';
import { createEndpoint, removeStaleSockets } from './socketPath';

/** Per-workspace: the permission epoch in which the user started the server here (absent when stopped). */
export const STARTED_HERE_KEY = 'filemaker.ai.externalServer.startedHere';
/** Global: counts how many times the permission setting was turned off. */
export const PERMISSION_EPOCH_KEY = 'filemaker.ai.externalServer.permissionEpoch';
/** Global: the last state of the permission setting this extension saw. */
export const PERMISSION_SEEN_KEY = 'filemaker.ai.externalServer.permissionSeen';

export interface McpControllerDeps {
  core: McpToolCore;
  /** The extension's global storage folder; the server does not start without an absolute one. */
  globalStoragePath: string | undefined;
  /** `dist/aiMcpShim.js` inside the installed extension. */
  extensionShimPath?: string;
  serverInfo: { name: string; version: string };
  /** `filemaker.ai.externalServer.enabled`, read from the user's settings only. It is a permission, not a switch. */
  isEnabled: () => boolean;
  /** `vscode.env.remoteName`. */
  remoteName: () => string | undefined;
  workspaceFolders: () => string[];
  /**
   * workspaceState: the permission epoch in which the user started the server in this
   * workspace, or undefined. It is honoured only while it equals the current epoch.
   */
  state: { get(): number | undefined; set(value: number | undefined): PromiseLike<void> | void };
  /**
   * globalState: the permission epoch (bumped whenever the setting is seen turned off, so a
   * workspace that was closed at that moment does not revive its flag when the setting is
   * turned on again) and the last permission state seen.
   */
  permission: {
    epoch(): number;
    bump(): PromiseLike<void> | void;
    seenEnabled(): boolean | undefined;
    setSeenEnabled(value: boolean): PromiseLike<void> | void;
  };
  log: (message: string) => void;
  /** Tells the user something (an external program connected). */
  notify?: (message: string) => void;
  /** For tests. */
  processStartTime?: () => Promise<string | undefined>;
  liveness?: Liveness;
}

const NOTIFY_INTERVAL_MS = 30_000;

/**
 * Owns the external AI server of this window. The user setting is only a permission: the
 * server runs in a window after the user starts it there (which sets a per-workspace flag),
 * runs again on later launches of that workspace while the flag and the setting both hold,
 * and stays stopped after the user stops it (which clears the flag).
 */
export class AiMcpController implements vscode.Disposable {
  private server: AiMcpServer | undefined;
  private starting: Promise<void> | undefined;
  private discoveryFile: string | undefined;
  private socketPath: string | undefined;
  private lastNotice = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changed.event;
  private readonly onExit = (): void => {
    for (const path of [this.discoveryFile, this.socketPath]) {
      if (path) {
        try {
          rmSync(path, { force: true });
        } catch {
          // Best effort at process exit.
        }
      }
    }
  };

  public constructor(private readonly deps: McpControllerDeps) {}

  public isRunning(): boolean {
    return this.server?.isRunning() === true;
  }

  public connectionCount(): number {
    return this.server?.connectionCount() ?? 0;
  }

  // ---------------------------------------------------------------------------------------
  // What the user does

  /**
   * The user, after a confirmation, starts the server in this window AND wants it to come back
   * when this workspace is reopened. Only this method remembers anything; `start()` does not.
   */
  public async startHere(): Promise<void> {
    await this.start();
    await this.deps.state.set(this.deps.permission.epoch());
  }

  /** The user stops the server in this window: it stays stopped, also after a restart. */
  public async stopHere(): Promise<void> {
    await this.deps.state.set(undefined);
    await this.stop();
  }

  /**
   * Notes the state of the permission setting. When it is seen off (now, or on activation
   * after being turned off while no window was open) the epoch advances, which ends every
   * workspace's "started here" memory, open or not.
   */
  public async reconcilePermission(): Promise<void> {
    const enabled = this.deps.isEnabled();
    if (!enabled && this.deps.permission.seenEnabled() !== false) {
      await this.deps.permission.bump();
    }
    if (this.deps.permission.seenEnabled() !== enabled) {
      await this.deps.permission.setSeenEnabled(enabled);
    }
  }

  /** On activation: start only if the permission is on AND the user started it here in the current permission epoch. */
  public async autostart(): Promise<void> {
    await this.reconcilePermission();
    if (this.deps.isEnabled() && this.deps.state.get() === this.deps.permission.epoch()) {
      try {
        await this.start();
      } catch (error) {
        this.deps.log(`AI server for external tools not started: ${(error as Error).message}`);
      }
    }
  }

  /** The permission setting changed: if it is off, the server stops, the flag is cleared and the epoch advances. */
  public async handleSettingChange(): Promise<void> {
    await this.reconcilePermission();
    if (!this.deps.isEnabled() && (this.isRunning() || this.deps.state.get() !== undefined)) {
      await this.stopHere();
    }
  }

  // ---------------------------------------------------------------------------------------
  // Lifecycle

  public start(): Promise<void> {
    // Two callers at once get the same attempt, not two servers.
    this.starting ??= this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.server) {
      return;
    }
    const remote = this.deps.remoteName();
    if (remote) {
      throw new Error(
        `The AI server for external tools is not supported in remote windows (${remote}): an MCP client on this computer cannot reach a socket on the remote host.`
      );
    }
    if (!this.deps.isEnabled()) {
      throw new Error('Turn on filemaker.ai.externalServer.enabled in your user settings first.');
    }
    const storage = this.deps.globalStoragePath;
    if (!storage || !isAbsolute(storage)) {
      throw new Error('The extension\'s storage folder is not available, so the AI server for external tools was not started.');
    }

    const startTime = await (this.deps.processStartTime ?? (() => getProcessStartTime(process.pid)))();
    if (!startTime) {
      throw new Error('Cannot read this process\'s start time on this system, so the shim could not verify it. The AI server was not started.');
    }

    const token = newToken();
    const endpoint = await createEndpoint({ scope: storage });
    const server = new AiMcpServer({
      core: this.deps.core,
      token,
      endpoint: endpoint.path,
      serverInfo: this.deps.serverInfo,
      log: this.deps.log,
      onConnectionChange: (event) => this.connectionChanged(event)
    });
    await server.start();

    try {
      const directory = discoveryDirectory(storage);
      await this.cleanUp(directory, endpoint);
      const folders = this.deps.workspaceFolders();
      this.discoveryFile = await writeDiscovery(directory, discoveryFileName(folders, process.pid), {
        version: DISCOVERY_VERSION,
        socketPath: endpoint.path,
        pid: process.pid,
        startTime,
        token,
        workspaceFolders: folders,
        label: vscode.workspace.name ?? `window-${process.pid}`,
        created: new Date().toISOString()
      });
      if (this.deps.extensionShimPath) {
        await installShim(this.deps.extensionShimPath, storage);
      }
    } catch (error) {
      await server.stop();
      if (this.discoveryFile) {
        await removeDiscovery(this.discoveryFile);
        this.discoveryFile = undefined;
      }
      throw error;
    }

    this.socketPath = endpoint.isPipe ? undefined : endpoint.path;
    process.once('exit', this.onExit);
    this.server = server;
    this.deps.log('AI server for external tools started.');
    this.changed.fire();
  }

  public async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    process.off('exit', this.onExit);
    if (server) {
      await server.stop();
    }
    if (this.discoveryFile) {
      await removeDiscovery(this.discoveryFile);
      this.discoveryFile = undefined;
    }
    if (this.socketPath) {
      rmSync(this.socketPath, { force: true });
      this.socketPath = undefined;
    }
    if (server) {
      this.deps.log('AI server for external tools stopped.');
      this.changed.fire();
    }
  }

  public notifyToolsChanged(): void {
    this.server?.notifyIfToolsChanged();
  }

  public dispose(): void {
    void this.stop();
    this.changed.dispose();
  }

  private connectionChanged(event: { type: 'connected' | 'disconnected'; count: number }): void {
    this.changed.fire();
    const now = Date.now();
    if (event.type === 'connected' && now - this.lastNotice >= NOTIFY_INTERVAL_MS) {
      this.lastNotice = now;
      this.deps.notify?.(
        'An external program connected to the FileMaker AI server in this window (see "FileMaker: Show AI Activity"). You still approve layouts and every change.'
      );
    }
  }

  /**
   * Removes discovery files of processes that are gone, and sockets nobody uses. A file whose
   * process is running but whose start time could not be read is kept: it may be another
   * window's.
   */
  private async cleanUp(directory: string, endpoint: { path: string; isPipe: boolean }): Promise<void> {
    try {
      await ensureOwnerOnlyDirectory(directory);
      const scan = await scanDiscovery(directory, this.deps.liveness);
      for (const file of scan.stale) {
        await removeDiscovery(file);
      }
      if (!endpoint.isPipe) {
        const inUse = new Set<string>([endpoint.path]);
        for (const window of [...scan.live, ...scan.unverified]) {
          inUse.add(window.record.socketPath);
        }
        await removeStaleSockets(dirname(endpoint.path), inUse);
      }
    } catch {
      // The folder does not exist yet or is unsafe; writeDiscovery checks it.
    }
  }
}
