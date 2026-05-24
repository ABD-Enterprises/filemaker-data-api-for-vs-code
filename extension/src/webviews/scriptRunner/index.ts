import * as vscode from 'vscode';

import { FMClientError } from '../../services/errors';
import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { ConnectionProfile, RunScriptRequest } from '../../types/fm';
import { generateCurlSnippet, generateFetchSnippet, type SnippetRequest } from '../../utils/snippetGen';
import { buildWebviewCsp, createNonce } from '../common/csp';
import {
  getOptionalBooleanField,
  getStringField,
  toRecord
} from '../common/messageValidation';

interface ScriptRunnerOpenOptions {
  profileId?: string;
  layout?: string;
  recordId?: string;
}

interface RunScriptPayload {
  profileId: string;
  layout: string;
  recordId?: string;
  scriptName: string;
  scriptParam?: string;
}

interface CopySnippetPayload extends RunScriptPayload {
  includeAuthHeader?: boolean;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'loadLayouts'; profileId: string }
  | { type: 'runScript'; payload: RunScriptPayload }
  | { type: 'copyCurl'; payload: CopySnippetPayload }
  | { type: 'copyFetch'; payload: CopySnippetPayload };

export class ScriptRunnerPanel {
  private static currentPanel: ScriptRunnerPanel | undefined;

  private pendingDefaults: ScriptRunnerOpenOptions | undefined;
  private lastResult: unknown;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly fmClient: FMClient,
    private readonly logger: Logger,
    defaults?: ScriptRunnerOpenOptions
  ) {
    this.pendingDefaults = defaults;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => {
      ScriptRunnerPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    fmClient: FMClient,
    logger: Logger,
    defaults?: ScriptRunnerOpenOptions
  ): void {
    const column = vscode.ViewColumn.One;

    if (ScriptRunnerPanel.currentPanel) {
      ScriptRunnerPanel.currentPanel.panel.reveal(column);
      ScriptRunnerPanel.currentPanel.pendingDefaults = defaults;
      void ScriptRunnerPanel.currentPanel.sendInit();
      return;
    }

    const panel = vscode.window.createWebviewPanel('filemakerScriptRunner', 'FileMaker Script Runner', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'scriptRunner', 'ui')
      ]
    });

    ScriptRunnerPanel.currentPanel = new ScriptRunnerPanel(
      panel,
      context,
      profileStore,
      fmClient,
      logger,
      defaults
    );
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = this.parseMessage(rawMessage);
    if (!message) {
      return;
    }

    switch (message.type) {
      case 'ready':
        await this.sendInit();
        break;
      case 'loadLayouts':
        await this.loadLayouts(message.profileId);
        break;
      case 'runScript':
        await this.runScript(message.payload);
        break;
      case 'copyCurl':
        await this.copyCurl(message.payload);
        break;
      case 'copyFetch':
        await this.copyFetch(message.payload);
        break;
      default:
        break;
    }
  }

  private async sendInit(): Promise<void> {
    const profiles = await this.profileStore.listProfiles();
    const configuration = vscode.workspace.getConfiguration('filemaker');
    const scriptRunnerEnabled = configuration.get<boolean>('features.scriptRunner.enabled', true);
    const includeAuthByDefault = configuration.get<boolean>('snippets.includeAuthByDefault', false);
    const parameterBuilderEnabled = configuration.get<boolean>('scripts.parameterBuilder.enabled', true);

    await this.panel.webview.postMessage({
      type: 'init',
      payload: {
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          database: profile.database,
          authMode: profile.authMode
        })),
        activeProfileId: this.profileStore.getActiveProfileId(),
        defaults: this.pendingDefaults,
        scriptRunnerEnabled,
        includeAuthByDefault,
        parameterBuilderEnabled
      }
    });

    this.pendingDefaults = undefined;
  }

  private async loadLayouts(profileId: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);

    if (!profile) {
      await this.postError('Connection profile not found.');
      return;
    }

    try {
      const layouts = await this.fmClient.listLayouts(profile);
      await this.panel.webview.postMessage({
        type: 'layoutsLoaded',
        payload: {
          profileId,
          layouts
        }
      });
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private async runScript(payload: RunScriptPayload): Promise<void> {
    const scriptRunnerEnabled = vscode.workspace
      .getConfiguration('filemaker')
      .get<boolean>('features.scriptRunner.enabled', true);
    const offlineMode = vscode.workspace.getConfiguration('filemaker').get<boolean>('offline.mode', false);

    if (!scriptRunnerEnabled) {
      await this.panel.webview.postMessage({
        type: 'unsupported',
        message: 'Script runner is disabled by setting filemaker.features.scriptRunner.enabled.'
      });
      return;
    }
    if (offlineMode) {
      await this.panel.webview.postMessage({
        type: 'unsupported',
        message: 'Offline mode is enabled; script execution is disabled.'
      });
      return;
    }

    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Connection profile not found.');
      return;
    }

    try {
      const request = validateRunScriptPayload(payload);
      const result = await this.fmClient.runScript(profile, request);

      this.lastResult = {
        profileId: payload.profileId,
        request,
        result
      };

      await this.panel.webview.postMessage({
        type: 'scriptResult',
        payload: this.lastResult
      });
    } catch (error) {
      if (error instanceof FMClientError && error.code === 'SCRIPT_UNSUPPORTED') {
        await this.panel.webview.postMessage({
          type: 'unsupported',
          message: error.message
        });
        return;
      }

      this.logger.warn('Script runner failed.', { error, payload });
      await this.postError(formatError(error));
    }
  }

  private async copyCurl(payload: CopySnippetPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Connection profile not found.');
      return;
    }

    try {
      const request = validateRunScriptPayload(payload);
      const snippetRequest = this.toSnippetRequest(profile, request);
      const snippet = generateCurlSnippet(snippetRequest, {
        includeAuthHeader: payload.includeAuthHeader
      });

      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage('Copied curl snippet to clipboard.');
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private async copyFetch(payload: CopySnippetPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Connection profile not found.');
      return;
    }

    try {
      const request = validateRunScriptPayload(payload);
      const snippetRequest = this.toSnippetRequest(profile, request);
      const snippet = generateFetchSnippet(snippetRequest, {
        includeAuthHeader: payload.includeAuthHeader
      });

      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage('Copied fetch snippet to clipboard.');
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private toSnippetRequest(profile: ConnectionProfile, request: RunScriptRequest): SnippetRequest {
    if (profile.authMode === 'proxy') {
      const endpoint = profile.proxyEndpoint ?? '';

      return {
        method: 'POST',
        url: endpoint,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer <PROXY_API_KEY>'
        },
        body: {
          action: 'runScript',
          profile: {
            id: profile.id,
            database: profile.database,
            serverUrl: profile.serverUrl
          },
          payload: request
        }
      };
    }

    const apiBasePath = profile.apiBasePath ?? '/fmi/data';
    const versionPath = profile.apiVersionPath ?? 'vLatest';

    return {
      method: 'POST',
      url: `${profile.serverUrl.replace(/\/+$/, '')}${apiBasePath}/${versionPath}/databases/${encodeURIComponent(profile.database)}/layouts/${encodeURIComponent(request.layout)}/script/${encodeURIComponent(request.scriptName)}`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer <SESSION_TOKEN>'
      },
      body: {
        scriptParam: request.scriptParam,
        recordId: request.recordId
      }
    };
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'error',
      message
    });
  }

  private parseMessage(rawMessage: unknown): IncomingMessage | undefined {
    const value = toRecord(rawMessage);
    if (!value) {
      return undefined;
    }

    if (value.type === 'ready') {
      return { type: 'ready' };
    }

    const profileId = getStringField(value, 'profileId');
    if (value.type === 'loadLayouts' && profileId) {
      return {
        type: 'loadLayouts',
        profileId
      };
    }

    if (value.type === 'runScript') {
      const payload = parseRunPayload(value.payload);
      if (!payload) {
        return undefined;
      }

      return {
        type: 'runScript',
        payload
      };
    }

    if (value.type === 'copyCurl') {
      const payload = parseCopyPayload(value.payload);
      if (!payload) {
        return undefined;
      }

      return {
        type: 'copyCurl',
        payload
      };
    }

    if (value.type === 'copyFetch') {
      const payload = parseCopyPayload(value.payload);
      if (!payload) {
        return undefined;
      }

      return {
        type: 'copyFetch',
        payload
      };
    }

    return undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'scriptRunner', 'ui', 'styles.css')
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'scriptRunner', 'ui', 'index.js')
    );

    const nonce = createNonce();
    const csp = buildWebviewCsp(webview, {
      nonce
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>FileMaker Script Runner</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>FileMaker Script Runner</h1>
      <p>Run FileMaker scripts with safe request previews.</p>
    </header>

    <section class="panel">
      <div class="row">
        <label for="profileSelect">Profile</label>
        <select id="profileSelect"></select>
      </div>
      <div class="row">
        <label for="layoutSelect">Layout</label>
        <select id="layoutSelect"></select>
      </div>
      <div class="row">
        <label for="recordIdInput">Record ID (optional)</label>
        <input id="recordIdInput" type="text" placeholder="1" />
      </div>
      <div class="row">
        <label for="scriptNameInput">Script Name</label>
        <input id="scriptNameInput" type="text" placeholder="MyScript" />
      </div>
      <div class="row">
        <label for="scriptParamInput">Script Parameter (optional)</label>
        <div class="parameter-input-group">
          <textarea id="scriptParamInput" rows="3" placeholder="Any string payload"></textarea>
          <button id="buildParameterButton" type="button" aria-expanded="false" aria-controls="parameterBuilderPanel">Build Parameter</button>
        </div>
      </div>
      <section id="parameterBuilderPanel" class="panel builder-panel hidden" aria-labelledby="parameterBuilderTitle">
        <h2 id="parameterBuilderTitle">Build Parameter</h2>
        <div id="parameterRows" class="builder-rows"></div>
        <div class="builder-toolbar">
          <button id="addParameterRowButton" type="button">Add Row</button>
        </div>
        <div class="row">
          <label for="parameterPreview">JSON Preview</label>
          <pre id="parameterPreview" class="parameter-preview" role="status" aria-live="polite">{}</pre>
        </div>
        <p id="parameterBuilderStatus" class="status builder-status" role="status" aria-live="polite"></p>
        <div class="actions builder-actions">
          <button id="applyParameterButton" type="button">Apply Parameter</button>
          <button id="closeParameterBuilderButton" type="button" class="secondary">Close</button>
        </div>
      </section>
      <div class="row inline">
        <label class="toggle"><input id="includeAuthCheckbox" type="checkbox" /> Include auth header in snippets</label>
      </div>
      <div class="actions">
        <button id="runButton">Run Script</button>
        <button id="copyCurlButton">Copy as curl</button>
        <button id="copyFetchButton">Copy as fetch()</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section class="panel">
      <h2>Result</h2>
      <div id="summary" class="summary" role="status" aria-live="polite">No script run yet.</div>
      <pre id="rawResult" class="raw"></pre>
    </section>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseRunPayload(value: unknown): RunScriptPayload | undefined {
  const payload = toRecord(value);
  if (!payload) {
    return undefined;
  }

  const profileId = getStringField(payload, 'profileId');
  const layout = getStringField(payload, 'layout');
  const scriptName = getStringField(payload, 'scriptName');

  if (!profileId || !layout || !scriptName) {
    return undefined;
  }

  return {
    profileId,
    layout,
    scriptName,
    scriptParam: getStringField(payload, 'scriptParam'),
    recordId: getStringField(payload, 'recordId')
  };
}

function parseCopyPayload(value: unknown): CopySnippetPayload | undefined {
  const payload = parseRunPayload(value);
  if (!payload) {
    return undefined;
  }

  const raw = toRecord(value);

  return {
    ...payload,
    includeAuthHeader: raw ? getOptionalBooleanField(raw, 'includeAuthHeader') : undefined
  };
}

function validateRunScriptPayload(payload: RunScriptPayload): RunScriptRequest {
  const scriptName = payload.scriptName.trim();

  if (!scriptName) {
    throw new FMClientError('Script name is required.');
  }

  const layout = payload.layout.trim();
  if (!layout) {
    throw new FMClientError('Layout is required.');
  }

  return {
    layout,
    scriptName,
    scriptParam: payload.scriptParam?.trim() ? payload.scriptParam : undefined,
    recordId: payload.recordId?.trim() ? payload.recordId : undefined
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected error.';
}
