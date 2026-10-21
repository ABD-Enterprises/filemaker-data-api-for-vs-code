import { designerLayoutMetadata } from '../../fmweb/fieldMetadata';
import * as vscode from 'vscode';

import { FMClientError } from '../../services/errors';
import type { FMClient } from '../../services/fmClient';
import { HistoryStore } from '../../services/historyStore';
import { describeScriptErrors } from '../../services/responseGuard';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { SavedQueriesStore } from '../../services/savedQueriesStore';
import type { FileMakerRecord, FindRecordsRequest, SavedQuery } from '../../types/fm';
import { recordsToCsv } from '../../utils/exportCsv';
import { exportColumns, exportRow } from '../../utils/exportRecords';
import { atomicExport } from '../../utils/atomicExport';
import { isFormulaNeutralizationOn } from '../../utils/userScopeSetting';
import { extractLayoutFieldNames } from '../../utils/layoutFields';
import { parseFindJson, parseSortJson } from '../../utils/jsonValidate';
import { deliverSnippet, parseSnippetDelivery, type SnippetDelivery } from '../../snippets/deliver';
import type { SnippetFormat } from '../../snippets/model';
import { buildWebviewCsp, createNonce } from '../common/csp';
import {
  getOptionalNumberField,
  getStringField,
  toRecord
} from '../common/messageValidation';
import { isFeatureEnabled } from '../../utils/policySetting';
import { versionFooterHtml } from '../../about/runtimeVersion';

interface QueryBuilderOpenOptions {
  profileId?: string;
  layout?: string;
  savedQuery?: SavedQuery;
}

interface RunQueryPayload {
  profileId: string;
  layout: string;
  findJson: string;
  sortJson?: string;
  limit?: number;
  offset?: number;
  queryId?: string;
  /** Webview-assigned sequence number, echoed back so stale results can be ignored. */
  runId?: number;
}

interface SaveQueryPayload extends RunQueryPayload {
  /** Empty when the webview has no name yet; the host then asks for one. */
  name: string;
}

interface OpenRecordPayload {
  profileId: string;
  layout: string;
  recordId: string;
  mode: 'view' | 'edit';
}

/** Upper bound for text the webview may put on the clipboard in one call. */
const MAX_CLIPBOARD_TEXT_LENGTH = 5_000_000;

interface CopySnippetPayload extends RunQueryPayload {
  delivery: SnippetDelivery;
}

interface UploadContainerPayload {
  profileId: string;
  layout: string;
}

interface QueryExecutionResult {
  profileId: string;
  layout: string;
  query: RunQueryPayload;
  result: {
    data: Array<Record<string, unknown>>;
    dataInfo?: Record<string, unknown>;
  };
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'loadLayouts'; profileId: string }
  | { type: 'loadFieldNames'; profileId: string; layout: string }
  | { type: 'runQuery'; payload: RunQueryPayload }
  | { type: 'saveQuery'; payload: SaveQueryPayload }
  | { type: 'exportResultsToEditor' }
  | { type: 'exportResultsJsonFile' }
  | { type: 'exportResultsCsvFile' }
  | { type: 'copyFetchSnippet'; payload: CopySnippetPayload }
  | { type: 'copyCurlSnippet'; payload: CopySnippetPayload }
  | { type: 'copyRequest'; payload: CopySnippetPayload }
  | { type: 'uploadContainer'; payload: UploadContainerPayload }
  | { type: 'openRecord'; payload: OpenRecordPayload }
  | { type: 'copyText'; text: string; label: string }
  | { type: 'refreshHistory' };

export class QueryBuilderPanel {
  private static currentPanel: QueryBuilderPanel | undefined;

  private lastResult: QueryExecutionResult | undefined;
  private pendingDefaults: QueryBuilderOpenOptions | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly savedQueriesStore: SavedQueriesStore,
    private readonly historyStore: HistoryStore,
    private readonly fmClient: FMClient,
    private readonly logger: Logger,
    defaults?: QueryBuilderOpenOptions
  ) {
    this.pendingDefaults = defaults;
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      QueryBuilderPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    savedQueriesStore: SavedQueriesStore,
    fmClient: FMClient,
    logger: Logger,
    defaults?: QueryBuilderOpenOptions,
    historyStore?: HistoryStore
  ): void {
    const column = vscode.ViewColumn.One;

    if (QueryBuilderPanel.currentPanel) {
      QueryBuilderPanel.currentPanel.panel.reveal(column);
      QueryBuilderPanel.currentPanel.pendingDefaults = defaults;
      void QueryBuilderPanel.currentPanel.sendInitState();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerQueryBuilder',
      'FileMaker Query Builder',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'queryBuilder', 'ui')
        ]
      }
    );

    QueryBuilderPanel.currentPanel = new QueryBuilderPanel(
      panel,
      context,
      profileStore,
      savedQueriesStore,
      historyStore ?? new HistoryStore(context.workspaceState),
      fmClient,
      logger,
      defaults
    );
  }

  public static requestSaveCurrentQuery(): boolean {
    if (!QueryBuilderPanel.currentPanel) {
      return false;
    }

    void QueryBuilderPanel.currentPanel.panel.webview.postMessage({
      type: 'saveCurrentQuery'
    });

    return true;
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = this.parseIncomingMessage(rawMessage);
    if (!message) {
      await this.reportRejectedRequest(rawMessage);
      return;
    }

    try {
      await this.dispatchMessage(message);
    } catch (error) {
      this.logger.error('Query builder request failed.', { type: message.type, error });
      await this.postError(
        this.formatError(error),
        message.type === 'runQuery' ? message.payload.runId : undefined
      );
    }
  }

  /**
   * The webview waits for a reply to requests it makes (Run shows "Running…"),
   * so a request that fails validation still gets an error back.
   */
  private async reportRejectedRequest(rawMessage: unknown): Promise<void> {
    const value = toRecord(rawMessage);
    const type = value ? getStringField(value, 'type') : undefined;
    const messages: Record<string, string> = {
      runQuery: 'Enter a find request before running the query.',
      saveQuery: 'Enter a find request before saving the query.',
      copyFetchSnippet: 'Enter a find request before copying it.',
      copyCurlSnippet: 'Enter a find request before copying it.',
      copyRequest: 'Enter a find request before copying it.',
      copyText: 'Nothing to copy, or the results are too large to copy. Save them as CSV instead.',
      openRecord: 'That row has no record ID to open.'
    };
    const text = type ? messages[type] : undefined;
    if (text) {
      const payload = value ? toRecord(value.payload) : undefined;
      const runId = type === 'runQuery' && payload ? getOptionalNumberField(payload, 'runId') : undefined;
      await this.postError(text, runId);
    }
  }

  private async dispatchMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendInitState();
        break;
      case 'loadLayouts':
        await this.handleLoadLayouts(message.profileId);
        break;
      case 'loadFieldNames':
        await this.handleLoadFieldNames(message.profileId, message.layout);
        break;
      case 'runQuery':
        await this.handleRunQuery(message.payload);
        break;
      case 'saveQuery':
        await this.handleSaveQuery(message.payload);
        break;
      case 'exportResultsToEditor':
        await this.exportResultsToEditor();
        break;
      case 'exportResultsJsonFile':
        await this.exportResultsJsonFile();
        break;
      case 'exportResultsCsvFile':
        await this.exportResultsCsvFile();
        break;
      case 'copyFetchSnippet':
      case 'copyCurlSnippet':
      case 'copyRequest':
        await this.copyRequest(message.payload);
        break;
      case 'uploadContainer':
        await this.uploadContainer(message.payload);
        break;
      case 'openRecord':
        await this.openRecord(message.payload);
        break;
      case 'copyText':
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage(`Copied ${message.label} to clipboard.`);
        break;
      case 'refreshHistory':
        await this.sendHistory();
        break;
      default:
        break;
    }
  }

  private async sendInitState(): Promise<void> {
    const profiles = await this.profileStore.listProfiles();
    const savedQueries = await this.savedQueriesStore.listSavedQueries();

    const filemakerConfig = vscode.workspace.getConfiguration('filemaker');
    const includeAuthByDefault = filemakerConfig.get<boolean>('snippets.includeAuthByDefault', false);
    const recordEditEnabled = isFeatureEnabled(filemakerConfig, 'features.recordEdit.enabled');

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
        savedQueries,
        defaults: this.pendingDefaults,
        includeAuthByDefault,
        recordEditEnabled,
        neutralizeFormulas: isFormulaNeutralizationOn(filemakerConfig)
      }
    });

    await this.sendHistory();

    this.pendingDefaults = undefined;
  }

  private async sendHistory(): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'history',
      payload: this.historyStore.listEntries()
    });
  }

  private async handleLoadLayouts(profileId: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      await this.postError('The selected connection profile could not be found.');
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
      this.logger.error('Failed to load layouts for query builder.', { profileId, error });
      await this.postError(this.formatError(error));
    }
  }

  private async handleLoadFieldNames(profileId: string, layout: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      await this.panel.webview.postMessage({
        type: 'fieldNamesLoaded',
        payload: { profileId, layout, fieldNames: [], error: 'Profile not found.' }
      });
      return;
    }

    try {
      const metadata = await this.fmClient.getLayoutMetadata(profile, layout);
      const fieldNames = extractLayoutFieldNames(metadata);
      await this.panel.webview.postMessage({
        type: 'fieldNamesLoaded',
        payload: { profileId, layout, fieldNames, fieldMetadata: designerLayoutMetadata(layout, metadata).fields }
      });
    } catch (error) {
      this.logger.warn('Failed to load field names for query builder.', { profileId, layout, error });
      await this.panel.webview.postMessage({
        type: 'fieldNamesLoaded',
        payload: {
          profileId,
          layout,
          fieldNames: [],
          error: this.formatError(error)
        }
      });
    }
  }

  private async handleRunQuery(payload: RunQueryPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('The selected connection profile no longer exists.', payload.runId);
      return;
    }

    try {
      const request = this.toFindRequest(payload);
      const result = await this.fmClient.findRecords(profile, payload.layout, request);
      if (result.scriptErrors && result.scriptErrors.length > 0) {
        void vscode.window.showWarningMessage(`The find worked, but ${describeScriptErrors(result.scriptErrors)}.`);
      }

      this.lastResult = {
        profileId: payload.profileId,
        layout: payload.layout,
        query: payload,
        result: {
          data: result.data,
          dataInfo: result.dataInfo
        }
      };

      await this.panel.webview.postMessage({
        type: 'queryResult',
        payload: this.lastResult
      });
    } catch (error) {
      await this.postError(this.formatError(error), payload.runId);
      return;
    }

    try {
      await this.sendHistory();
    } catch (error) {
      this.logger.warn('Failed to refresh query builder history.', { error });
    }
  }

  private async handleSaveQuery(payload: SaveQueryPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('The selected profile no longer exists.');
      return;
    }

    try {
      const request = this.toFindRequest(payload);
      const existing = payload.queryId
        ? await this.savedQueriesStore.getSavedQuery(payload.queryId)
        : undefined;

      const name = await vscode.window.showInputBox({
        title: existing ? 'Save Query' : 'Save Query As',
        prompt: existing
          ? 'Query name. Keep it to update the saved query, or change it to rename.'
          : 'Name for the new saved query',
        value: payload.name.trim() || existing?.name || payload.layout,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'Enter a name.')
      });
      if (!name) {
        return;
      }

      const query = await this.savedQueriesStore.saveSavedQuery({
        id: existing?.id ?? payload.queryId,
        name: name.trim(),
        profileId: payload.profileId,
        database: profile.database,
        layout: payload.layout,
        findJson: request.query,
        sortJson: request.sort,
        limit: request.limit,
        offset: request.offset,
        createdAt: existing?.createdAt
      });

      await this.panel.webview.postMessage({
        type: 'savedQueries',
        payload: await this.savedQueriesStore.listSavedQueries()
      });

      await this.panel.webview.postMessage({
        type: 'querySaved',
        payload: { id: query.id, name: query.name }
      });

      await vscode.commands.executeCommand('filemakerDataApiTools.refreshExplorer');
      vscode.window.showInformationMessage(`Saved query "${query.name}".`);
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private toFindRequest(payload: RunQueryPayload): FindRecordsRequest {
    const findValidation = parseFindJson(payload.findJson || '[{}]');

    if (!findValidation.ok || !findValidation.value) {
      throw new FMClientError(findValidation.error ?? 'Find JSON is invalid.');
    }

    let sortValidationValue: Array<Record<string, unknown>> | undefined;

    if (payload.sortJson && payload.sortJson.trim().length > 0) {
      const sortValidation = parseSortJson(payload.sortJson);
      if (!sortValidation.ok || !sortValidation.value) {
        throw new FMClientError(sortValidation.error ?? 'Sort JSON is invalid.');
      }

      sortValidationValue = sortValidation.value;
    }

    const limit = this.parseNumber(payload.limit, 'Limit');
    const offset = this.parseNumber(payload.offset, 'Offset');

    return {
      query: findValidation.value,
      sort: sortValidationValue,
      limit,
      offset
    };
  }

  private parseNumber(value: number | undefined, label: string): number | undefined {
    if (value === undefined || Number.isNaN(value)) {
      return undefined;
    }

    if (!Number.isInteger(value) || value < 0) {
      throw new FMClientError(`${label} must be a non-negative integer.`);
    }

    return value;
  }

  private async exportResultsToEditor(): Promise<void> {
    if (!this.lastResult) {
      await this.postError('No query results available to export.');
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(this.lastResult, null, 2)
    });

    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async exportResultsJsonFile(): Promise<void> {
    if (!this.lastResult) {
      await this.postError('No query results available to export.');
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      title: 'Export Query Results (JSON)',
      filters: {
        JSON: ['json']
      },
      defaultUri: vscode.Uri.file('filemaker-query-results.json')
    });

    if (!uri) {
      return;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(this.lastResult, null, 2), 'utf8'));

    vscode.window.showInformationMessage('Exported query results JSON file.');
  }

  private async exportResultsCsvFile(): Promise<void> {
    if (!this.lastResult) {
      await this.postError('No query results available to export.');
      return;
    }

    const rows = this.toCsvRows(this.lastResult);
    const excelChoice = await vscode.window.showQuickPick(['Standard CSV', 'Excel-compatible CSV (UTF-8 BOM)'], { title: 'CSV format' });
    if (!excelChoice) return;
    const csv = recordsToCsv(rows, {
      excelCompatible: excelChoice.startsWith('Excel'),
      neutralizeFormulas: isFormulaNeutralizationOn(vscode.workspace.getConfiguration('filemaker'))
    });

    const uri = await vscode.window.showSaveDialog({
      title: 'Export Query Results (CSV)',
      filters: {
        CSV: ['csv']
      },
      defaultUri: vscode.Uri.file('filemaker-query-results.csv')
    });

    if (!uri) {
      return;
    }

    const file = await atomicExport(uri.fsPath);
    try { await file.write(csv); await file.close(); }
    catch (error) { await file.abort(); throw error; }
    vscode.window.showInformationMessage('Exported query results CSV file.');
  }

  private toCsvRows(result: QueryExecutionResult): Array<Map<string, unknown>> {
    const records = result.result.data as FileMakerRecord[];
    const names = [...new Set(records.flatMap((record) => Object.keys(record.fieldData ?? {})))];
    const meta = exportColumns(names);
    let noteColumn = '__portalNote (export information)';
    while (names.includes(noteColumn)) noteColumn = '_' + noteColumn;
    return records.map((record) => exportRow(record, meta, noteColumn));
  }

  private async copyRequest(payload: CopySnippetPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Cannot copy the request because the profile was not found.');
      return;
    }

    try {
      await deliverSnippet(
        profile,
        { kind: 'find', layout: payload.layout, request: this.toFindRequest(payload) },
        payload.delivery
      );
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private async uploadContainer(payload: UploadContainerPayload): Promise<void> {
    try {
      const completed = await vscode.commands.executeCommand<boolean>(
        'filemakerDataApiTools.uploadContainer',
        payload
      );

      await this.panel.webview.postMessage({
        type: 'containerUploadResult',
        payload: {
          completed: completed === true
        }
      });
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private async openRecord(payload: OpenRecordPayload): Promise<void> {
    const command =
      payload.mode === 'edit' ? 'filemakerDataApiTools.openRecordEditor' : 'filemakerDataApiTools.openRecordViewer';
    try {
      await vscode.commands.executeCommand(command, {
        profileId: payload.profileId,
        layout: payload.layout,
        recordId: payload.recordId
      });
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error while processing query builder request.';
  }

  /** `runId` ties a failure to the run that caused it, so the webview can end that run's busy state. */
  private async postError(message: string, runId?: number): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'error',
      message,
      ...(runId === undefined ? {} : { runId })
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
      case 'loadFieldNames': {
        const profileId = getStringField(value, 'profileId');
        const layout = getStringField(value, 'layout');
        if (!profileId || !layout) {
          return undefined;
        }
        return { type, profileId, layout };
      }
      case 'runQuery': {
        const payload = this.parseRunQueryPayload(value.payload);
        if (!payload) {
          return undefined;
        }

        return {
          type,
          payload
        };
      }
      case 'saveQuery': {
        const payload = this.parseSaveQueryPayload(value.payload);
        if (!payload) {
          return undefined;
        }

        return {
          type,
          payload
        };
      }
      case 'exportResultsToEditor':
      case 'exportResultsJsonFile':
      case 'exportResultsCsvFile':
      case 'refreshHistory':
        return { type };
      case 'copyFetchSnippet':
      case 'copyCurlSnippet':
      case 'copyRequest': {
        // The two older message types name their format; `copyRequest` carries it in the payload.
        const fallback: SnippetFormat | undefined =
          type === 'copyFetchSnippet' ? 'fetch' : type === 'copyCurlSnippet' ? 'curl' : undefined;
        const payload = this.parseCopySnippetPayload(value.payload, fallback);
        if (!payload) {
          return undefined;
        }

        return {
          type,
          payload
        };
      }
      case 'uploadContainer': {
        const payload = this.parseUploadContainerPayload(value.payload);
        if (!payload) {
          return undefined;
        }

        return {
          type,
          payload
        };
      }
      case 'openRecord': {
        const payload = this.parseOpenRecordPayload(value.payload);
        return payload ? { type, payload } : undefined;
      }
      case 'copyText': {
        const text = typeof value.text === 'string' ? value.text : undefined;
        const label = getStringField(value, 'label') ?? 'text';
        if (text === undefined || text.length === 0 || text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
          return undefined;
        }
        return { type, text, label: label.slice(0, 80) };
      }
      default:
        return undefined;
    }
  }

  private parseRunQueryPayload(rawPayload: unknown): RunQueryPayload | undefined {
    const payload = toRecord(rawPayload);
    if (!payload) {
      return undefined;
    }

    const profileId = getStringField(payload, 'profileId');
    const layout = getStringField(payload, 'layout');
    if (!profileId || !layout) {
      return undefined;
    }

    const findJson = getStringField(payload, 'findJson');
    if (!findJson) {
      return undefined;
    }

    return {
      profileId,
      layout,
      findJson,
      sortJson: getStringField(payload, 'sortJson'),
      limit: getOptionalNumberField(payload, 'limit'),
      offset: getOptionalNumberField(payload, 'offset'),
      queryId: getStringField(payload, 'queryId'),
      runId: getOptionalNumberField(payload, 'runId')
    };
  }

  private parseSaveQueryPayload(rawPayload: unknown): SaveQueryPayload | undefined {
    const payload = this.parseRunQueryPayload(rawPayload);
    if (!payload) {
      return undefined;
    }

    const raw = toRecord(rawPayload);
    const name = raw ? getStringField(raw, 'name') : undefined;

    return {
      ...payload,
      name: (name ?? '').trim()
    };
  }

  private parseOpenRecordPayload(rawPayload: unknown): OpenRecordPayload | undefined {
    const payload = toRecord(rawPayload);
    if (!payload) {
      return undefined;
    }

    const profileId = getStringField(payload, 'profileId');
    const layout = getStringField(payload, 'layout');
    const recordId = getStringField(payload, 'recordId');
    if (!profileId || !layout || !recordId || !/^\d+$/.test(recordId)) {
      return undefined;
    }

    return {
      profileId,
      layout,
      recordId,
      mode: getStringField(payload, 'mode') === 'edit' ? 'edit' : 'view'
    };
  }

  private parseCopySnippetPayload(rawPayload: unknown, fallbackFormat?: SnippetFormat): CopySnippetPayload | undefined {
    const payload = this.parseRunQueryPayload(rawPayload);
    const raw = toRecord(rawPayload);
    const delivery = raw ? parseSnippetDelivery(raw, fallbackFormat) : undefined;
    if (!payload || !delivery) {
      return undefined;
    }

    return { ...payload, delivery };
  }

  private parseUploadContainerPayload(rawPayload: unknown): UploadContainerPayload | undefined {
    const payload = toRecord(rawPayload);
    if (!payload) {
      return undefined;
    }

    const profileId = getStringField(payload, 'profileId');
    const layout = getStringField(payload, 'layout');
    if (!profileId || !layout) {
      return undefined;
    }

    return {
      profileId,
      layout
    };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const uiUri = (file: string): vscode.Uri =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'queryBuilder', 'ui', file)
      );
    const standardsStyleUri = uiUri('fieldStandards.css');
    const standardsScriptUri = uiUri('fieldStandards.js');
    const styleUri = uiUri('styles.css');
    const findFormUri = uiUri('findForm.js');
    const cellTextUri = uiUri('cellText.js');
    const scriptUri = uiUri('index.js');

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
  <title>FileMaker Query Builder</title>
  <link rel="stylesheet" href="${styleUri}" />
  <link rel="stylesheet" href="${standardsStyleUri}" />
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>FileMaker Query Builder</h1>
      <p>Build a find request, run it, and open any record from the results.</p>
    </header>

    <section class="panel" aria-labelledby="queryHeading">
      <h2 id="queryHeading" class="visually-hidden">Query</h2>
      <div class="grid source-grid">
        <div>
          <label for="profileSelect">Profile</label>
          <select id="profileSelect"></select>
        </div>
        <div>
          <label for="layoutSelect">Layout</label>
          <select id="layoutSelect"></select>
        </div>
        <div>
          <label for="savedQueriesSelect">Saved query</label>
          <div class="inline-control">
            <select id="savedQueriesSelect"></select>
            <button id="loadSavedButton" type="button" class="secondary">Load</button>
          </div>
        </div>
      </div>

      <div class="tabs" role="tablist" aria-label="Query editor">
        <button id="formTab" type="button" role="tab" aria-selected="true" aria-controls="formEditor">Form</button>
        <button id="jsonTab" type="button" role="tab" aria-selected="false" aria-controls="jsonEditor" tabindex="-1">JSON</button>
      </div>

      <div id="formEditor" role="tabpanel" aria-labelledby="formTab">
        <datalist id="fieldNameOptions"></datalist>
        <div id="fieldNamesHint" class="hint"></div>
        <div id="requestList" class="request-list"></div>
        <button id="addRequestButton" type="button" class="secondary">Add request (OR)</button>
        <fieldset class="sort-editor">
          <legend>Sort</legend>
          <div id="sortList"></div>
          <button id="addSortButton" type="button" class="secondary">Add sort field</button>
        </fieldset>
      </div>

      <div id="jsonEditor" role="tabpanel" aria-labelledby="jsonTab" class="hidden">
        <div class="row">
          <label for="findJson">Find JSON (array of requests)</label>
          <textarea id="findJson" rows="6" spellcheck="false">[{}]</textarea>
        </div>
        <div class="row">
          <label for="sortJson">Sort JSON (optional array)</label>
          <textarea id="sortJson" rows="3" spellcheck="false"></textarea>
        </div>
      </div>

      <div class="grid paging-grid">
        <div>
          <label for="limitInput">Records per page</label>
          <input id="limitInput" type="number" min="1" placeholder="100" />
        </div>
        <div>
          <label for="offsetInput">Start at record</label>
          <input id="offsetInput" type="number" min="1" placeholder="1" />
        </div>
      </div>

      <div class="actions">
        <button id="runButton" type="button" title="Run query (Ctrl/Cmd+Enter)">Run</button>
        <button id="saveButton" type="button" class="secondary" title="Save this query (asks for a name)">Save…</button>
        <details class="menu" id="exportMenu">
          <summary class="secondary">Export</summary>
          <div class="menu-items">
            <button id="copyTableButton" type="button">Copy results as table</button>
            <button id="exportCsvButton" type="button">Save results as CSV…</button>
            <button id="exportJsonButton" type="button">Save results as JSON…</button>
            <button id="exportEditorButton" type="button">Open results in editor</button>
          </div>
        </details>
        <details class="menu" id="copyRequestMenu">
          <summary class="secondary">Copy request</summary>
          <div class="menu-items">
            <button id="copyCurlButton" type="button" data-copy-format="curl">Copy as curl</button>
            <button id="copyFetchButton" type="button" data-copy-format="fetch">Copy as fetch()</button>
            <button id="copyHttpButton" type="button" data-copy-format="http">Copy as .http (REST Client)</button>
            <button id="copyPostmanButton" type="button" data-copy-format="postman">Copy as Postman collection</button>
            <button id="copyTypeScriptButton" type="button" data-copy-format="typescript">Copy as TypeScript</button>
            <button id="saveHttpButton" type="button" data-copy-format="http" data-copy-destination="editor" title="Opens the request in a new editor. Save it where you want.">Save as .http file…</button>
            <label class="toggle menu-toggle"><input id="includeAuthCheckbox" type="checkbox" /> Include auth header</label>
          </div>
        </details>
        <button id="uploadContainerButton" type="button" class="secondary">Upload to container…</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section class="panel" aria-labelledby="resultsHeading">
      <div class="results-header">
        <h2 id="resultsHeading">Results</h2>
        <div class="tabs compact" role="tablist" aria-label="Results view">
          <button id="tableViewTab" type="button" role="tab" aria-selected="true" aria-controls="tableContainer">Table</button>
          <button id="rawViewTab" type="button" role="tab" aria-selected="false" aria-controls="rawContainer" tabindex="-1">JSON</button>
        </div>
      </div>
      <div class="results-toolbar">
        <div id="resultSummary" class="summary" role="status" aria-live="polite"></div>
        <div class="pager">
          <button id="prevButton" type="button" class="secondary" disabled>Previous page</button>
          <button id="nextButton" type="button" class="secondary" disabled>Next page</button>
        </div>
      </div>
      <div id="tableContainer" class="table-wrap" role="tabpanel" aria-labelledby="tableViewTab"></div>
      <pre id="rawContainer" class="raw hidden" role="tabpanel" aria-labelledby="rawViewTab"></pre>
    </section>

    <details class="panel history-panel">
      <summary><h2>Request history</h2></summary>
      <div id="historyContainer" class="history"></div>
    </details>
  </div>

  ${versionFooterHtml()}
  <script nonce="${nonce}" src="${findFormUri}"></script>
  <script nonce="${nonce}" src="${cellTextUri}"></script>
  <script nonce="${nonce}" src="${standardsScriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
