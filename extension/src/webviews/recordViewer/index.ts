import * as vscode from 'vscode';

import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { FileMakerRecord } from '../../types/fm';
import { getWebviewI18nScript, localize } from '../../i18n';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { getStringField, toRecord } from '../common/messageValidation';

interface RecordViewerOpenOptions {
  profileId?: string;
  layout?: string;
  recordId?: string;
}

interface LoadRecordPayload {
  profileId: string;
  layout: string;
  recordId: string;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'loadLayouts'; profileId: string }
  | { type: 'loadRecord'; payload: LoadRecordPayload }
  | { type: 'exportRecord' };

export class RecordViewerPanel {
  private static currentPanel: RecordViewerPanel | undefined;

  private pendingDefaults: RecordViewerOpenOptions | undefined;
  private lastRecord: { profileId: string; layout: string; record: FileMakerRecord } | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly fmClient: FMClient,
    private readonly logger: Logger,
    defaults?: RecordViewerOpenOptions
  ) {
    this.pendingDefaults = defaults;
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      RecordViewerPanel.currentPanel = undefined;
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
    defaults?: RecordViewerOpenOptions
  ): void {
    const column = vscode.ViewColumn.One;

    if (RecordViewerPanel.currentPanel) {
      RecordViewerPanel.currentPanel.panel.reveal(column);
      RecordViewerPanel.currentPanel.pendingDefaults = defaults;
      void RecordViewerPanel.currentPanel.sendInitState();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerRecordViewer',
      localize('webviews.recordViewer.panelTitle', 'FileMaker Record Viewer'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'recordViewer', 'ui')
        ]
      }
    );

    RecordViewerPanel.currentPanel = new RecordViewerPanel(
      panel,
      context,
      profileStore,
      fmClient,
      logger,
      defaults
    );
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = this.parseIncomingMessage(rawMessage);
    if (!message) {
      return;
    }

    switch (message.type) {
      case 'ready': {
        await this.sendInitState();
        break;
      }
      case 'loadLayouts': {
        await this.handleLoadLayouts(message.profileId);
        break;
      }
      case 'loadRecord': {
        await this.handleLoadRecord(message.payload);
        break;
      }
      case 'exportRecord': {
        await this.exportRecord();
        break;
      }
      default:
        break;
    }
  }

  private async sendInitState(): Promise<void> {
    const profiles = await this.profileStore.listProfiles();

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
        defaults: this.pendingDefaults
      }
    });

    this.pendingDefaults = undefined;
  }

  private async handleLoadLayouts(profileId: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      await this.postError(
        localize(
          'webviews.recordViewer.selectedProfileNotFound',
          'The selected connection profile could not be found.'
        )
      );
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
      this.logger.error('Failed to load layouts for record viewer.', { profileId, error });
      await this.postError(this.formatError(error));
    }
  }

  private async handleLoadRecord(payload: LoadRecordPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError(
        localize(
          'webviews.recordViewer.selectedProfileMissing',
          'The selected profile no longer exists.'
        )
      );
      return;
    }

    try {
      const record = await this.fmClient.getRecord(profile, payload.layout, payload.recordId);
      this.lastRecord = {
        profileId: payload.profileId,
        layout: payload.layout,
        record
      };

      await this.panel.webview.postMessage({
        type: 'recordLoaded',
        payload: this.lastRecord
      });
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private async exportRecord(): Promise<void> {
    if (!this.lastRecord) {
      await this.postError(
        localize('webviews.recordViewer.noRecordLoaded', 'No record loaded yet.')
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(this.lastRecord, null, 2)
    });

    await vscode.window.showTextDocument(document, { preview: false });
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return localize(
      'webviews.recordViewer.unknownError',
      'Unknown error while processing record viewer request.'
    );
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'error',
      message
    });
  }

  private parseIncomingMessage(rawMessage: unknown): IncomingMessage | undefined {
    const value = toRecord(rawMessage);
    if (!value) {
      return undefined;
    }

    const type = getStringField(value, 'type');
    if (!type) {
      return undefined;
    }

    switch (type) {
      case 'ready':
        return { type };
      case 'loadLayouts': {
        const profileId = getStringField(value, 'profileId');
        if (!profileId) {
          return undefined;
        }

        return {
          type,
          profileId
        };
      }
      case 'loadRecord': {
        const payload = this.parseLoadRecordPayload(value.payload);
        if (!payload) {
          return undefined;
        }

        return {
          type,
          payload
        };
      }
      case 'exportRecord':
        return { type };
      default:
        return undefined;
    }
  }

  private parseLoadRecordPayload(rawPayload: unknown): LoadRecordPayload | undefined {
    const payload = toRecord(rawPayload);
    if (!payload) {
      return undefined;
    }

    const profileId = getStringField(payload, 'profileId');
    const layout = getStringField(payload, 'layout');
    const recordId = getStringField(payload, 'recordId');
    if (!profileId || !layout || !recordId) {
      return undefined;
    }

    return {
      profileId,
      layout,
      recordId
    };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'webviews',
        'recordViewer',
        'ui',
        'styles.css'
      )
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'webviews',
        'recordViewer',
        'ui',
        'index.js'
      )
    );

    const nonce = createNonce();
    const csp = buildWebviewCsp(webview, {
      nonce
    });
    const i18nScript = getWebviewI18nScript(nonce);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>${localize('webviews.recordViewer.htmlTitle', 'FileMaker Record Viewer')}</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>${localize('webviews.recordViewer.heading', 'FileMaker Record Viewer')}</h1>
      <p>${localize('webviews.recordViewer.subtitle', 'Inspect one record and related portal data.')}</p>
    </header>

    <section class="panel">
      <div class="row">
        <label for="profileSelect">${localize('webviews.recordViewer.profileLabel', 'Profile')}</label>
        <select id="profileSelect"></select>
      </div>
      <div class="row">
        <label for="layoutSelect">${localize('webviews.recordViewer.layoutLabel', 'Layout')}</label>
        <select id="layoutSelect"></select>
      </div>
      <div class="row">
        <label for="recordIdInput">${localize('webviews.recordViewer.recordIdLabel', 'Record ID')}</label>
        <input id="recordIdInput" type="text" placeholder="1" />
      </div>
      <div class="actions">
        <button id="loadButton">${localize('webviews.recordViewer.loadButton', 'Load Record')}</button>
        <button id="exportButton">${localize('webviews.recordViewer.exportButton', 'Export Record JSON')}</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section class="panel">
      <h2>${localize('webviews.recordViewer.recordHeading', 'Record')}</h2>
      <div id="fieldDataContainer"></div>
      <div id="relatedDataContainer" class="related"></div>
      <pre id="rawJson" class="raw"></pre>
    </section>
  </div>

  ${i18nScript}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
