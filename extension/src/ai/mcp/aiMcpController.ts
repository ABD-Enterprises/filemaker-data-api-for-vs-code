import { rmSync } from 'fs';
import * as vscode from 'vscode';

import { AiMcpServer, type McpToolCore } from './aiMcpServer';
import { newToken } from './auth';
import { DISCOVERY_VERSION, discoveryFileName, removeDiscovery, scanDiscovery, writeDiscovery } from './discovery';
import { discoveryDirectory } from './mcpConfig';
import { getProcessStartTime } from './processInfo';
import { createEndpoint } from './socketPath';

export interface McpControllerDeps {
  core: McpToolCore;
  globalStoragePath: string;
  serverInfo: { name: string; version: string };
  /** `filemaker.ai.externalServer.enabled`, read from the user's settings only. */
  isEnabled: () => boolean;
  /** `vscode.env.remoteName`. */
  remoteName: () => string | undefined;
  workspaceFolders: () => string[];
  log: (message: string) => void;
}

/** Owns the lifecycle of the external AI server in this window. */
export class AiMcpController implements vscode.Disposable {
  private server: AiMcpServer | undefined;
  private discoveryFile: string | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changed.event;
  private readonly onExit = (): void => {
    if (this.discoveryFile) {
      try {
        rmSync(this.discoveryFile, { force: true });
      } catch {
        // Best effort at process exit.
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

  public async start(): Promise<void> {
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

    const startTime = await getProcessStartTime(process.pid);
    if (!startTime) {
      throw new Error('Cannot read this process\'s start time on this system, so the shim could not verify it. The AI server was not started.');
    }

    const token = newToken();
    const endpoint = await createEndpoint();
    const server = new AiMcpServer({
      core: this.deps.core,
      token,
      endpoint: endpoint.path,
      serverInfo: this.deps.serverInfo,
      log: this.deps.log
    });
    await server.start();

    try {
      const directory = discoveryDirectory(this.deps.globalStoragePath);
      await this.removeStaleFiles(directory);
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
    } catch (error) {
      await server.stop();
      throw error;
    }

    process.once('exit', this.onExit);
    this.server = server;
    this.deps.log('AI server for external tools started.');
    this.changed.fire();
  }

  public async stop(): Promise<void> {
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

  /** Discovery files of processes that are gone are removed (only in our own folder). */
  private async removeStaleFiles(directory: string): Promise<void> {
    try {
      const scan = await scanDiscovery(directory);
      for (const file of scan.stale) {
        await removeDiscovery(file);
      }
    } catch {
      // The folder does not exist yet or is unsafe; writeDiscovery checks it.
    }
  }
}
