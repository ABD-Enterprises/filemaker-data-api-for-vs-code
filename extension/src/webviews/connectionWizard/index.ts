import * as vscode from 'vscode';

import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { SecretStore } from '../../services/secretStore';
import type { ConnectionProfile } from '../../types/fm';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { toRecord } from '../common/messageValidation';
import {
  validateDatabaseName,
  validateServerUrl
} from '../../utils/jsonValidate';
import { toUserErrorMessage } from '../../utils/errorUx';

export type ConnectionWizardTestPolicy = 'off' | 'warn' | 'block';

interface ConnectionWizardOptions {
  /** Resolved at message time so settings updates flow live. */
  getTestPolicy?: () => ConnectionWizardTestPolicy;
}

interface WizardFormData {
  name: string;
  authMode: 'direct' | 'proxy';
  serverUrl: string;
  database: string;
  apiBasePath: string;
  apiVersionPath: string;
  username?: string;
  password?: string;
  proxyEndpoint?: string;
  proxyApiKey?: string;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'save'; payload: WizardFormData }
  | { type: 'testConnection'; payload: WizardFormData };

export class ConnectionWizardPanel {
  private static currentPanel: ConnectionWizardPanel | undefined;

  private editingProfile: ConnectionProfile | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly secretStore: SecretStore,
    private readonly fmClient: FMClient,
    private readonly logger: Logger,
    editingProfile?: ConnectionProfile,
    private readonly options: ConnectionWizardOptions = {}
  ) {
    this.editingProfile = editingProfile;
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      ConnectionWizardPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    secretStore: SecretStore,
    fmClient: FMClient,
    logger: Logger,
    editingProfile?: ConnectionProfile,
    options: ConnectionWizardOptions = {}
  ): void {
    if (ConnectionWizardPanel.currentPanel) {
      ConnectionWizardPanel.currentPanel.editingProfile = editingProfile;
      ConnectionWizardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      void ConnectionWizardPanel.currentPanel.sendLoadProfile();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerConnectionWizard',
      editingProfile ? `Edit Profile — ${editingProfile.name}` : 'Add Connection Profile',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'connectionWizard', 'ui')
        ]
      }
    );

    ConnectionWizardPanel.currentPanel = new ConnectionWizardPanel(
      panel,
      context,
      profileStore,
      secretStore,
      fmClient,
      logger,
      editingProfile,
      options
    );
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const record = toRecord(raw);
    if (!record) {
      return;
    }

    const type = record.type;

    if (type === 'save' || type === 'testConnection') {
      const payload = record.payload;
      if (!payload || typeof payload !== 'object') {
        return;
      }
    }

    const incoming = record as unknown as IncomingMessage;

    switch (incoming.type) {
      case 'ready':
        await this.sendInit();
        await this.sendLoadProfile();
        break;
      case 'save':
        await this.handleSave(incoming.payload);
        break;
      case 'testConnection':
        await this.handleTestConnection(incoming.payload);
        break;
    }
  }

  private async sendInit(): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'init',
      testPolicy: this.options.getTestPolicy?.() ?? 'warn'
    });
  }

  private async sendLoadProfile(): Promise<void> {
    if (this.editingProfile) {
      await this.panel.webview.postMessage({
        type: 'loadProfile',
        payload: this.editingProfile
      });
    }
  }

  private async handleSave(data: WizardFormData): Promise<void> {
    try {
      const serverValidation = validateServerUrl(data.serverUrl);
      if (!serverValidation.ok) {
        await this.panel.webview.postMessage({
          type: 'saveError',
          message: serverValidation.error ?? 'Invalid server URL.'
        });
        return;
      }

      const dbValidation = validateDatabaseName(data.database);
      if (!dbValidation.ok) {
        await this.panel.webview.postMessage({
          type: 'saveError',
          message: dbValidation.error ?? 'Invalid database name.'
        });
        return;
      }

      const profile: ConnectionProfile = {
        id: this.editingProfile?.id ?? crypto.randomUUID(),
        name: data.name.trim(),
        authMode: data.authMode,
        serverUrl: serverValidation.value!,
        database: dbValidation.value!,
        apiBasePath: data.apiBasePath.trim(),
        apiVersionPath: data.apiVersionPath.trim()
      };

      if (data.authMode === 'direct') {
        profile.username = data.username?.trim();
      } else {
        profile.proxyEndpoint = data.proxyEndpoint?.trim();
      }

      await this.profileStore.upsertProfile(profile);

      if (data.authMode === 'direct') {
        if (data.password && data.password.length > 0) {
          await this.secretStore.setPassword(profile.id, data.password);
        }
        await this.secretStore.deleteProxyApiKey(profile.id);
      } else {
        if (data.proxyApiKey && data.proxyApiKey.length > 0) {
          await this.secretStore.setProxyApiKey(profile.id, data.proxyApiKey);
        }
        await this.secretStore.deletePassword(profile.id);
      }

      this.editingProfile = profile;

      await this.panel.webview.postMessage({
        type: 'saveSuccess',
        message: `Profile "${profile.name}" saved. Use FileMaker: Connect to start a session.`
      });
    } catch (error) {
      await this.panel.webview.postMessage({
        type: 'saveError',
        message: toUserErrorMessage(error, 'Failed to save profile.')
      });
    }
  }

  private async postTestProgress(phase: string): Promise<void> {
    await this.panel.webview.postMessage({ type: 'testProgress', phase });
  }

  private async handleTestConnection(data: WizardFormData): Promise<void> {
    const timeoutMs = vscode.workspace
      .getConfiguration('filemaker')
      .get<number>('requestTimeoutMs', 15_000);
    await this.panel.webview.postMessage({ type: 'testStarted', timeoutMs });

    try {
      const tempProfile: ConnectionProfile = {
        id: this.editingProfile?.id ?? 'test-connection',
        name: data.name.trim(),
        authMode: data.authMode,
        serverUrl: data.serverUrl.trim(),
        database: data.database.trim(),
        apiBasePath: data.apiBasePath.trim(),
        apiVersionPath: data.apiVersionPath.trim()
      };

      await this.postTestProgress('Preparing credentials…');
      if (data.authMode === 'direct') {
        tempProfile.username = data.username?.trim();

        if (data.password && data.password.length > 0) {
          await this.secretStore.setPassword(tempProfile.id, data.password);
        }
      } else {
        tempProfile.proxyEndpoint = data.proxyEndpoint?.trim();

        if (data.proxyApiKey && data.proxyApiKey.length > 0) {
          await this.secretStore.setProxyApiKey(tempProfile.id, data.proxyApiKey);
        }
      }

      await this.postTestProgress('Opening session…');
      await this.fmClient.createSession(tempProfile);

      await this.postTestProgress('Cleaning up…');
      await this.fmClient.deleteSession(tempProfile);

      await this.panel.webview.postMessage({
        type: 'testSuccess',
        message: 'Connection successful. Session opened and closed cleanly.'
      });
    } catch (error) {
      await this.panel.webview.postMessage({
        type: 'testError',
        message: toUserErrorMessage(error, 'Connection test failed.')
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = createNonce();
    const uiBase = vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webviews',
      'connectionWizard',
      'ui'
    );
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(uiBase, 'styles.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(uiBase, 'index.js'));
    const csp = buildWebviewCsp(webview, { nonce });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Connection Profile</title>
</head>
<body>
  <div class="container">
    <h1>Connection Profile</h1>
    <p class="subtitle">Configure a connection to your FileMaker Server.</p>

    <div class="form-section">
      <h2>Profile</h2>
      <div class="field">
        <label for="profileName">Profile Name</label>
        <input id="profileName" type="text" placeholder="e.g. Production Server" />
      </div>
    </div>

    <div class="form-section">
      <h2 id="auth-mode-heading">Authentication Mode</h2>
      <div class="mode-toggle" role="group" aria-labelledby="auth-mode-heading">
        <button type="button" id="modeDirectBtn" aria-pressed="true">Direct</button>
        <button type="button" id="modeProxyBtn" aria-pressed="false">Proxy</button>
      </div>
      <p class="hint" style="margin-top: -8px;">
        <strong>Direct</strong> connects to FileMaker Data API directly.
        <strong>Proxy</strong> connects through your middleware endpoint.
      </p>
    </div>

    <div class="form-section">
      <h2>Server</h2>
      <div class="field">
        <label for="serverUrl">Server URL</label>
        <input id="serverUrl" type="url" placeholder="https://fm.yourcompany.com" />
        <div class="hint">The HTTPS address of your FileMaker Server.</div>
      </div>
      <div class="field">
        <label for="database">Database Name</label>
        <input id="database" type="text" placeholder="MyDatabase" />
        <div class="hint">The hosted FileMaker database file name.</div>
      </div>
      <!--
        API Base Path and API Version are correct out of the box for 99% of
        servers. Surfacing them as top-level inputs makes new users second-
        guess whether they need to configure them, and they account for a
        chunk of "I don't know what to fill in" friction in the wizard.
        Hidden behind <details> so the defaults stay populated but the visual
        weight goes to fields that actually matter on first save.
      -->
      <details class="advanced-toggle">
        <summary>Advanced server options</summary>
        <div class="field">
          <label for="apiBasePath">API Base Path</label>
          <input id="apiBasePath" type="text" value="/fmi/data" />
          <div class="hint">Usually <code>/fmi/data</code>. Change only if your server uses a custom path.</div>
        </div>
        <div class="field">
          <label for="apiVersionPath">API Version</label>
          <input id="apiVersionPath" type="text" value="vLatest" />
          <div class="hint">Usually <code>vLatest</code>.</div>
        </div>
      </details>
    </div>

    <div id="directFields" class="form-section direct-fields">
      <h2>Credentials</h2>
      <div class="field">
        <label for="username">Username</label>
        <input id="username" type="text" placeholder="api_user" autocomplete="username" />
        <div class="hint">The FileMaker account with fmrest privilege.</div>
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" />
        <div class="hint">Stored securely in VS Code SecretStorage. Never written to disk.</div>
      </div>
    </div>

    <div id="proxyFields" class="form-section proxy-fields">
      <h2>Proxy Settings</h2>
      <div class="field">
        <label for="proxyEndpoint">Proxy Endpoint</label>
        <input id="proxyEndpoint" type="url" placeholder="https://api.yourcompany.com/fm-proxy" />
        <div class="hint">Your middleware endpoint URL.</div>
      </div>
      <div class="field">
        <label for="proxyApiKey">API Key (optional)</label>
        <input id="proxyApiKey" type="password" autocomplete="off" />
        <div class="hint">Sent as a Bearer token to your proxy. Stored securely.</div>
      </div>
    </div>

    <div class="actions">
      <button type="button" id="saveBtn" class="primary">Save Profile</button>
      <button type="button" id="testBtn" class="secondary">Test Connection</button>
    </div>

    <div id="status" class="status" role="status" aria-live="polite"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
