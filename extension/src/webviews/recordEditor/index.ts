import * as vscode from 'vscode';

import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import { RecordEditService } from '../../services/recordEditService';
import type { SchemaService } from '../../services/schemaService';
import type { FileMakerFieldMetadata, FileMakerRecord } from '../../types/fm';
import { getWebviewI18nScript, localize } from '../../i18n';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { getStringField, toRecord } from '../common/messageValidation';

interface RecordEditorOpenOptions {
  profileId?: string;
  layout?: string;
  recordId?: string;
  mode?: 'edit' | 'create';
}

interface LoadRecordPayload {
  profileId: string;
  layout: string;
  recordId: string;
}

interface DraftPayload extends LoadRecordPayload {
  originalFieldData: Record<string, unknown>;
  draftFieldData: Record<string, unknown>;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'loadLayouts'; profileId: string }
  | { type: 'loadRecord'; payload: LoadRecordPayload }
  | { type: 'validateDraft'; payload: DraftPayload }
  | { type: 'previewPatch'; payload: DraftPayload }
  | { type: 'saveRecord'; payload: DraftPayload }
  | {
      type: 'createRecord';
      payload: { profileId: string; layout: string; fieldData: Record<string, unknown> };
    }
  | { type: 'exportRecord' };

export class RecordEditorPanel {
  private static currentPanel: RecordEditorPanel | undefined;

  private pendingDefaults: RecordEditorOpenOptions | undefined;
  private loadedRecord: { profileId: string; layout: string; record: FileMakerRecord } | undefined;
  private fieldsByLayout = new Map<string, FileMakerFieldMetadata[]>();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly fmClient: FMClient,
    private readonly schemaService: SchemaService,
    private readonly logger: Logger,
    private readonly recordEditService: RecordEditService,
    defaults?: RecordEditorOpenOptions
  ) {
    this.pendingDefaults = defaults;
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      RecordEditorPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    fmClient: FMClient,
    schemaService: SchemaService,
    logger: Logger,
    defaults?: RecordEditorOpenOptions
  ): void {
    const column = vscode.ViewColumn.One;

    if (RecordEditorPanel.currentPanel) {
      RecordEditorPanel.currentPanel.panel.reveal(column);
      RecordEditorPanel.currentPanel.pendingDefaults = defaults;
      void RecordEditorPanel.currentPanel.sendInit();
      return;
    }

    const isCreateMode = defaults?.mode === 'create';
    const panelTitle =
      isCreateMode && defaults?.layout
        ? localize('webviews.recordEditor.createPanelTitle', 'Create Record - {0}', defaults.layout)
        : localize('webviews.recordEditor.panelTitle', 'FileMaker Record Editor');

    const panel = vscode.window.createWebviewPanel('filemakerRecordEditor', panelTitle, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'recordEditor', 'ui')
      ]
    });

    RecordEditorPanel.currentPanel = new RecordEditorPanel(
      panel,
      context,
      profileStore,
      fmClient,
      schemaService,
      logger,
      new RecordEditService(fmClient),
      defaults
    );
  }

  private async handleMessage(message: unknown): Promise<void> {
    const incoming = parseIncomingMessage(message);
    if (!incoming) {
      return;
    }

    switch (incoming.type) {
      case 'ready':
        await this.sendInit();
        break;
      case 'loadLayouts':
        await this.loadLayouts(incoming.profileId);
        break;
      case 'loadRecord':
        await this.loadRecord(incoming.payload);
        break;
      case 'validateDraft':
        await this.validateDraft(incoming.payload);
        break;
      case 'previewPatch':
        await this.previewPatch(incoming.payload);
        break;
      case 'saveRecord':
        await this.saveRecord(incoming.payload);
        break;
      case 'createRecord':
        await this.handleCreateRecord(incoming.payload);
        break;
      case 'exportRecord':
        await this.exportCurrentRecord();
        break;
      default:
        break;
    }
  }

  private async sendInit(): Promise<void> {
    const profiles = await this.profileStore.listProfiles();

    await this.panel.webview.postMessage({
      type: 'init',
      payload: {
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          database: profile.database
        })),
        activeProfileId: this.profileStore.getActiveProfileId(),
        defaults: this.pendingDefaults
      }
    });

    this.pendingDefaults = undefined;
  }

  private async loadLayouts(profileId: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      await this.postError(
        localize('webviews.recordEditor.selectedProfileNotFound', 'Selected profile was not found.')
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
      await this.postError(formatError(error));
    }
  }

  private async loadRecord(payload: LoadRecordPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError(
        localize('webviews.recordEditor.selectedProfileNotFound', 'Selected profile was not found.')
      );
      return;
    }

    try {
      const record = await this.fmClient.getRecord(profile, payload.layout, payload.recordId);
      this.loadedRecord = {
        profileId: payload.profileId,
        layout: payload.layout,
        record
      };

      const schema = await this.schemaService.getFields(profile, payload.layout);
      if (schema.supported) {
        this.fieldsByLayout.set(this.layoutKey(payload.profileId, payload.layout), schema.fields);
      }

      await this.panel.webview.postMessage({
        type: 'recordLoaded',
        payload: {
          profileId: payload.profileId,
          layout: payload.layout,
          record,
          fields: schema.fields,
          metadataSupported: schema.supported
        }
      });
    } catch (error) {
      this.logger.error('Failed to load record for editor.', {
        error,
        profileId: payload.profileId,
        layout: payload.layout,
        recordId: payload.recordId
      });
      await this.postError(formatError(error));
    }
  }

  private async validateDraft(payload: DraftPayload): Promise<void> {
    const fields = this.fieldsByLayout.get(this.layoutKey(payload.profileId, payload.layout));
    const validation = this.recordEditService.validateDraft(payload.draftFieldData, fields);

    await this.panel.webview.postMessage({
      type: 'draftValidated',
      payload: validation
    });
  }

  private async previewPatch(payload: DraftPayload): Promise<void> {
    const preview = this.recordEditService.previewPatch(
      payload.originalFieldData,
      payload.draftFieldData
    );
    await this.panel.webview.postMessage({
      type: 'patchPreview',
      payload: preview
    });
  }

  private async saveRecord(payload: DraftPayload): Promise<void> {
    if (vscode.workspace.getConfiguration('filemaker').get<boolean>('offline.mode', false)) {
      await this.postError(
        localize(
          'webviews.recordEditor.offlineWritesDisabled',
          'Offline mode is enabled; record writes are disabled.'
        )
      );
      return;
    }

    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError(
        localize('webviews.recordEditor.selectedProfileNotFound', 'Selected profile was not found.')
      );
      return;
    }

    const preview = this.recordEditService.previewPatch(
      payload.originalFieldData,
      payload.draftFieldData
    );
    if (preview.changedFields.length === 0) {
      await this.postError(
        localize('webviews.recordEditor.noFieldChanges', 'No field changes detected.')
      );
      return;
    }

    const saveLabel = localize('webviews.recordEditor.saveAction', 'Save');
    const confirmation = await vscode.window.showWarningMessage(
      localize(
        'webviews.recordEditor.saveConfirm',
        'Save {0} field changes to record {1}? ({2})\nRollback guidance: export the current record before save, then reapply previous values if needed.',
        preview.changedFields.length,
        payload.recordId,
        preview.changedFields.join(', ')
      ),
      { modal: true },
      saveLabel
    );

    if (confirmation !== saveLabel) {
      await this.panel.webview.postMessage({
        type: 'saveCancelled'
      });
      return;
    }

    try {
      const saveResult = await this.recordEditService.saveRecord(
        profile,
        payload.layout,
        payload.recordId,
        payload.originalFieldData,
        payload.draftFieldData
      );
      const refreshedRecord = await this.fmClient.getRecord(
        profile,
        payload.layout,
        payload.recordId
      );
      this.loadedRecord = {
        profileId: payload.profileId,
        layout: payload.layout,
        record: refreshedRecord
      };

      await this.panel.webview.postMessage({
        type: 'recordSaved',
        payload: {
          saveResult,
          record: refreshedRecord
        }
      });
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private async handleCreateRecord(payload: {
    profileId: string;
    layout: string;
    fieldData: Record<string, unknown>;
  }): Promise<void> {
    if (vscode.workspace.getConfiguration('filemaker').get<boolean>('offline.mode', false)) {
      await this.postError(
        localize(
          'webviews.recordEditor.offlineWritesDisabled',
          'Offline mode is enabled; record writes are disabled.'
        )
      );
      return;
    }

    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError(
        localize('webviews.recordEditor.selectedProfileNotFound', 'Selected profile was not found.')
      );
      return;
    }

    const nonEmptyFields = Object.fromEntries(
      Object.entries(payload.fieldData).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    );

    if (Object.keys(nonEmptyFields).length === 0) {
      await this.postError(
        localize(
          'webviews.recordEditor.createNeedsField',
          'At least one field must have a value to create a record.'
        )
      );
      return;
    }

    const createLabel = localize('webviews.recordEditor.createAction', 'Create');
    const confirmation = await vscode.window.showWarningMessage(
      localize(
        'webviews.recordEditor.createConfirm',
        'Create a new record in layout "{0}" with {1} field(s)?',
        payload.layout,
        Object.keys(nonEmptyFields).length
      ),
      { modal: true },
      createLabel
    );

    if (confirmation !== createLabel) {
      await this.panel.webview.postMessage({ type: 'saveCancelled' });
      return;
    }

    try {
      const result = await this.fmClient.createRecord(profile, payload.layout, nonEmptyFields);

      vscode.window.showInformationMessage(
        localize(
          'webviews.recordEditor.createSuccess',
          'Record created (ID: {0}).',
          result.recordId
        )
      );

      await this.panel.webview.postMessage({
        type: 'recordCreated',
        payload: { recordId: result.recordId, modId: result.modId }
      });
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private async exportCurrentRecord(): Promise<void> {
    if (!this.loadedRecord) {
      await this.postError(
        localize('webviews.recordEditor.noRecordLoaded', 'No record has been loaded.')
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(this.loadedRecord, null, 2)
    });

    await vscode.window.showTextDocument(document, { preview: false });
  }

  private layoutKey(profileId: string, layout: string): string {
    return `${profileId}::${layout}`;
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'error',
      message
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'webviews',
        'recordEditor',
        'ui',
        'styles.css'
      )
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'webviews',
        'recordEditor',
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
  <title>${localize('webviews.recordEditor.htmlTitle', 'FileMaker Record Editor')}</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>${localize('webviews.recordEditor.heading', 'FileMaker Record Editor')}</h1>
      <p>${localize('webviews.recordEditor.subtitle', 'Load a record, edit fieldData, preview patch JSON, and save safely.')}</p>
    </header>

    <section class="panel">
      <div class="row">
        <label for="profileSelect">${localize('webviews.recordEditor.profileLabel', 'Profile')}</label>
        <select id="profileSelect"></select>
      </div>
      <div class="row">
        <label for="layoutSelect">${localize('webviews.recordEditor.layoutLabel', 'Layout')}</label>
        <select id="layoutSelect"></select>
      </div>
      <div class="row">
        <label for="recordIdInput">${localize('webviews.recordEditor.recordIdLabel', 'Record ID')}</label>
        <input id="recordIdInput" type="text" placeholder="1" />
      </div>
      <div class="actions">
        <button id="loadButton">${localize('webviews.recordEditor.loadButton', 'Load')}</button>
        <button id="validateButton">${localize('webviews.recordEditor.validateButton', 'Validate')}</button>
        <button id="previewButton">${localize('webviews.recordEditor.previewButton', 'Preview Update JSON')}</button>
        <button id="saveButton">${localize('webviews.recordEditor.saveButton', 'Save')}</button>
        <button id="discardButton">${localize('webviews.recordEditor.discardButton', 'Discard Changes')}</button>
        <button id="exportButton">${localize('webviews.recordEditor.exportButton', 'Export Record JSON')}</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section class="panel">
      <h2>${localize('webviews.recordEditor.fieldDataHeading', 'Field Data')}</h2>
      <div id="fieldEditor"></div>
      <h3>${localize('webviews.recordEditor.patchPreviewHeading', 'Patch Preview')}</h3>
      <pre id="patchPreview" class="raw"></pre>
      <h3>${localize('webviews.recordEditor.rawRecordHeading', 'Raw Record JSON')}</h3>
      <pre id="rawRecord" class="raw"></pre>
    </section>
  </div>

  ${i18nScript}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseIncomingMessage(raw: unknown): IncomingMessage | undefined {
  const value = toRecord(raw);
  if (!value) {
    return undefined;
  }

  const type = getStringField(value, 'type');
  if (!type) {
    return undefined;
  }

  if (type === 'ready') {
    return { type };
  }

  const profileId = getStringField(value, 'profileId');
  if (type === 'loadLayouts' && profileId) {
    return {
      type,
      profileId
    };
  }

  if (type === 'exportRecord') {
    return { type };
  }

  if (
    type === 'loadRecord' ||
    type === 'validateDraft' ||
    type === 'previewPatch' ||
    type === 'saveRecord' ||
    type === 'createRecord'
  ) {
    const payload = parseDraftPayload(value.payload, type === 'loadRecord');
    if (!payload) {
      return undefined;
    }

    if (type === 'loadRecord') {
      return {
        type,
        payload
      };
    }

    if (!('originalFieldData' in payload) || !('draftFieldData' in payload)) {
      return undefined;
    }

    return {
      type,
      payload
    } as IncomingMessage;
  }

  return undefined;
}

function parseDraftPayload(raw: unknown, loadOnly = false): DraftPayload | undefined {
  const payload = toRecord(raw);
  if (!payload) {
    return undefined;
  }

  const profileId = getStringField(payload, 'profileId');
  const layout = getStringField(payload, 'layout');
  const recordId = getStringField(payload, 'recordId');
  if (!profileId || !layout || !recordId) {
    return undefined;
  }

  if (loadOnly) {
    return {
      profileId,
      layout,
      recordId,
      originalFieldData: {},
      draftFieldData: {}
    };
  }

  if (
    !payload.originalFieldData ||
    typeof payload.originalFieldData !== 'object' ||
    Array.isArray(payload.originalFieldData) ||
    !payload.draftFieldData ||
    typeof payload.draftFieldData !== 'object' ||
    Array.isArray(payload.draftFieldData)
  ) {
    return undefined;
  }

  return {
    profileId,
    layout,
    recordId,
    originalFieldData: payload.originalFieldData as Record<string, unknown>,
    draftFieldData: payload.draftFieldData as Record<string, unknown>
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return localize('webviews.recordEditor.unexpectedError', 'Unexpected error.');
}
