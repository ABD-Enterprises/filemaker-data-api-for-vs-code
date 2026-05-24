import * as vscode from 'vscode';

import { FMClientError } from '../../services/errors';
import type { FMClient } from '../../services/fmClient';
import { HistoryStore } from '../../services/historyStore';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { SavedQueriesStore } from '../../services/savedQueriesStore';
import type { ConnectionProfile, FindRecordsRequest, SavedQuery } from '../../types/fm';
import { getWebviewI18nScript, localize } from '../../i18n';
import { recordsToCsv } from '../../utils/exportCsv';
import { extractLayoutFieldNames } from '../../utils/layoutFields';
import { parseFindJson, parseSortJson } from '../../utils/jsonValidate';
import {
  generateCurlSnippet,
  generateFetchSnippet,
  type SnippetRequest
} from '../../utils/snippetGen';
import { buildWebviewCsp, createNonce } from '../common/csp';
import {
  getOptionalBooleanField,
  getOptionalNumberField,
  getStringField,
  toRecord
} from '../common/messageValidation';

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
}

interface SaveQueryPayload extends RunQueryPayload {
  name: string;
}

interface CopySnippetPayload extends RunQueryPayload {
  includeAuthHeader?: boolean;
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
      localize('webviews.queryBuilder.panelTitle', 'FileMaker Query Builder'),
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
      return;
    }

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
        await this.copyFetchSnippet(message.payload);
        break;
      case 'copyCurlSnippet':
        await this.copyCurlSnippet(message.payload);
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

    const includeAuthByDefault = vscode.workspace
      .getConfiguration('filemaker')
      .get<boolean>('snippets.includeAuthByDefault', false);

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
        includeAuthByDefault
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
      await this.postError(
        localize(
          'webviews.queryBuilder.selectedProfileNotFound',
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
        payload: { profileId, layout, fieldNames }
      });
    } catch (error) {
      this.logger.warn('Failed to load field names for query builder.', {
        profileId,
        layout,
        error
      });
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
      await this.postError(
        localize(
          'webviews.queryBuilder.selectedProfileMissing',
          'The selected connection profile no longer exists.'
        )
      );
      return;
    }

    try {
      const request = this.toFindRequest(payload);
      const result = await this.fmClient.findRecords(profile, payload.layout, request);

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

      await this.sendHistory();
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private async handleSaveQuery(payload: SaveQueryPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError(
        localize(
          'webviews.queryBuilder.selectedProfileNoLongerExists',
          'The selected profile no longer exists.'
        )
      );
      return;
    }

    try {
      const request = this.toFindRequest(payload);
      const existing = payload.queryId
        ? await this.savedQueriesStore.getSavedQuery(payload.queryId)
        : undefined;

      const query = await this.savedQueriesStore.saveSavedQuery({
        id: existing?.id ?? payload.queryId,
        name: payload.name.trim(),
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

      await vscode.commands.executeCommand('filemakerDataApiTools.refreshExplorer');
      vscode.window.showInformationMessage(
        localize('webviews.queryBuilder.savedQuery', 'Saved query "{0}".', query.name)
      );
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private toFindRequest(payload: RunQueryPayload): FindRecordsRequest {
    const findValidation = parseFindJson(payload.findJson || '[{}]');

    if (!findValidation.ok || !findValidation.value) {
      throw new FMClientError(
        findValidation.error ??
          localize('webviews.queryBuilder.findJsonInvalid', 'Find JSON is invalid.')
      );
    }

    let sortValidationValue: Array<Record<string, unknown>> | undefined;

    if (payload.sortJson && payload.sortJson.trim().length > 0) {
      const sortValidation = parseSortJson(payload.sortJson);
      if (!sortValidation.ok || !sortValidation.value) {
        throw new FMClientError(
          sortValidation.error ??
            localize('webviews.queryBuilder.sortJsonInvalid', 'Sort JSON is invalid.')
        );
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
      throw new FMClientError(
        localize(
          'webviews.queryBuilder.nonNegativeInteger',
          '{0} must be a non-negative integer.',
          label
        )
      );
    }

    return value;
  }

  private async exportResultsToEditor(): Promise<void> {
    if (!this.lastResult) {
      await this.postError(
        localize('webviews.queryBuilder.noResultsToExport', 'No query results available to export.')
      );
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
      await this.postError(
        localize('webviews.queryBuilder.noResultsToExport', 'No query results available to export.')
      );
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      title: localize('webviews.queryBuilder.exportJson.title', 'Export Query Results (JSON)'),
      filters: {
        JSON: ['json']
      },
      defaultUri: vscode.Uri.file('filemaker-query-results.json')
    });

    if (!uri) {
      return;
    }

    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(JSON.stringify(this.lastResult, null, 2), 'utf8')
    );

    vscode.window.showInformationMessage(
      localize('webviews.queryBuilder.exportJson.success', 'Exported query results JSON file.')
    );
  }

  private async exportResultsCsvFile(): Promise<void> {
    if (!this.lastResult) {
      await this.postError(
        localize('webviews.queryBuilder.noResultsToExport', 'No query results available to export.')
      );
      return;
    }

    const rows = this.toCsvRows(this.lastResult);
    const csv = recordsToCsv(rows);

    const uri = await vscode.window.showSaveDialog({
      title: localize('webviews.queryBuilder.exportCsv.title', 'Export Query Results (CSV)'),
      filters: {
        CSV: ['csv']
      },
      defaultUri: vscode.Uri.file('filemaker-query-results.csv')
    });

    if (!uri) {
      return;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
    vscode.window.showInformationMessage(
      localize('webviews.queryBuilder.exportCsv.success', 'Exported query results CSV file.')
    );
  }

  private toCsvRows(result: QueryExecutionResult): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = [];

    for (const item of result.result.data) {
      const fieldData =
        item && typeof item === 'object' && item.fieldData && typeof item.fieldData === 'object'
          ? (item.fieldData as Record<string, unknown>)
          : {};

      rows.push({
        recordId:
          item && typeof item === 'object' && 'recordId' in item
            ? (item as Record<string, unknown>).recordId
            : undefined,
        ...fieldData
      });
    }

    return rows;
  }

  private async copyFetchSnippet(payload: CopySnippetPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError(
        localize(
          'webviews.queryBuilder.snippetProfileNotFound',
          'Cannot generate snippet because the profile was not found.'
        )
      );
      return;
    }

    try {
      const request = this.toFindRequest(payload);
      const snippetRequest = this.toFindSnippetRequest(profile, payload.layout, request);
      const snippet = generateFetchSnippet(snippetRequest, {
        includeAuthHeader: payload.includeAuthHeader
      });

      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage(
        localize('webviews.queryBuilder.copyFetch.success', 'Copied fetch() snippet to clipboard.')
      );
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private async copyCurlSnippet(payload: CopySnippetPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError(
        localize(
          'webviews.queryBuilder.snippetProfileNotFound',
          'Cannot generate snippet because the profile was not found.'
        )
      );
      return;
    }

    try {
      const request = this.toFindRequest(payload);
      const snippetRequest = this.toFindSnippetRequest(profile, payload.layout, request);
      const snippet = generateCurlSnippet(snippetRequest, {
        includeAuthHeader: payload.includeAuthHeader
      });

      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage(
        localize('webviews.queryBuilder.copyCurl.success', 'Copied curl snippet to clipboard.')
      );
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private toFindSnippetRequest(
    profile: ConnectionProfile,
    layout: string,
    request: FindRecordsRequest
  ): SnippetRequest {
    if (profile.authMode === 'proxy') {
      return {
        method: 'POST',
        url: profile.proxyEndpoint ?? '',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer <PROXY_API_KEY>'
        },
        body: {
          action: 'findRecords',
          profile: {
            id: profile.id,
            database: profile.database,
            serverUrl: profile.serverUrl
          },
          payload: {
            layout,
            body: request
          }
        }
      };
    }

    const apiBasePath = profile.apiBasePath ?? '/fmi/data';
    const apiVersionPath = profile.apiVersionPath ?? 'vLatest';

    return {
      method: 'POST',
      url: `${profile.serverUrl.replace(/\/+$/, '')}${apiBasePath}/${apiVersionPath}/databases/${encodeURIComponent(profile.database)}/layouts/${encodeURIComponent(layout)}/_find`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer <SESSION_TOKEN>'
      },
      body: request
    };
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error while processing query builder request.';
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
      case 'copyFetchSnippet': {
        const payload = this.parseCopySnippetPayload(value.payload);
        if (!payload) {
          return undefined;
        }

        return {
          type,
          payload
        };
      }
      case 'copyCurlSnippet': {
        const payload = this.parseCopySnippetPayload(value.payload);
        if (!payload) {
          return undefined;
        }

        return {
          type,
          payload
        };
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
      queryId: getStringField(payload, 'queryId')
    };
  }

  private parseSaveQueryPayload(rawPayload: unknown): SaveQueryPayload | undefined {
    const payload = this.parseRunQueryPayload(rawPayload);
    if (!payload) {
      return undefined;
    }

    const raw = toRecord(rawPayload);
    const name = raw ? getStringField(raw, 'name') : undefined;
    if (!name || name.trim().length === 0) {
      return undefined;
    }

    return {
      ...payload,
      name: name.trim()
    };
  }

  private parseCopySnippetPayload(rawPayload: unknown): CopySnippetPayload | undefined {
    const payload = this.parseRunQueryPayload(rawPayload);
    if (!payload) {
      return undefined;
    }

    const raw = toRecord(rawPayload);

    return {
      ...payload,
      includeAuthHeader: raw ? getOptionalBooleanField(raw, 'includeAuthHeader') : undefined
    };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'webviews',
        'queryBuilder',
        'ui',
        'styles.css'
      )
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'webviews',
        'queryBuilder',
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
  <title>${localize('webviews.queryBuilder.htmlTitle', 'FileMaker Query Builder')}</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>${localize('webviews.queryBuilder.heading', 'FileMaker Query Builder')}</h1>
      <p>${localize('webviews.queryBuilder.subtitle', 'Build Data API find requests and inspect results.')}</p>
    </header>

    <section class="panel">
      <div class="row">
        <label for="profileSelect">${localize('webviews.queryBuilder.profileLabel', 'Profile')}</label>
        <select id="profileSelect"></select>
      </div>
      <div class="row">
        <label for="layoutSelect">${localize('webviews.queryBuilder.layoutLabel', 'Layout')}</label>
        <select id="layoutSelect"></select>
      </div>
      <div class="row">
        <label for="findJson">${localize('webviews.queryBuilder.findJsonLabel', 'Find JSON (array)')}</label>
        <textarea id="findJson" rows="6">[{ }]</textarea>
      </div>
      <div class="row">
        <label for="sortJson">${localize('webviews.queryBuilder.sortJsonLabel', 'Sort JSON (optional array)')}</label>
        <textarea id="sortJson" rows="3"></textarea>
      </div>
      <div class="grid">
        <div>
          <label for="limitInput">${localize('webviews.queryBuilder.limitLabel', 'Limit')}</label>
          <input id="limitInput" type="number" min="0" placeholder="100" />
        </div>
        <div>
          <label for="offsetInput">${localize('webviews.queryBuilder.offsetLabel', 'Offset')}</label>
          <input id="offsetInput" type="number" min="0" placeholder="1" />
        </div>
        <div>
          <label for="queryNameInput">${localize('webviews.queryBuilder.queryNameLabel', 'Saved Query Name')}</label>
          <input id="queryNameInput" type="text" placeholder="${localize('webviews.queryBuilder.queryNamePlaceholder', 'My Find Query')}" />
        </div>
      </div>
      <div class="row inline">
        <label class="toggle"><input id="includeAuthCheckbox" type="checkbox" /> ${localize('webviews.queryBuilder.includeAuthLabel', 'Include auth header in snippets')}</label>
      </div>
      <div class="actions">
        <button id="runButton">${localize('webviews.queryBuilder.runButton', 'Run')}</button>
        <button id="saveButton">${localize('webviews.queryBuilder.saveButton', 'Save Query')}</button>
        <button id="exportEditorButton">${localize('webviews.queryBuilder.openJsonButton', 'Open JSON in Editor')}</button>
        <button id="exportJsonButton">${localize('webviews.queryBuilder.exportJsonButton', 'Export JSON File')}</button>
        <button id="exportCsvButton">${localize('webviews.queryBuilder.exportCsvButton', 'Export CSV File')}</button>
        <button id="copyFetchButton">${localize('webviews.queryBuilder.copyFetchButton', 'Copy as fetch()')}</button>
        <button id="copyCurlButton">${localize('webviews.queryBuilder.copyCurlButton', 'Copy as curl')}</button>
      </div>
      <div class="saved">
        <label for="savedQueriesSelect">${localize('webviews.queryBuilder.savedQueriesLabel', 'Saved Queries')}</label>
        <select id="savedQueriesSelect"></select>
      </div>
      <div class="actions compact">
        <button id="loadSavedButton">${localize('webviews.queryBuilder.loadSavedButton', 'Load Saved Query')}</button>
        <button id="prevButton">${localize('webviews.queryBuilder.prevButton', 'Prev Page')}</button>
        <button id="nextButton">${localize('webviews.queryBuilder.nextButton', 'Next Page')}</button>
        <button id="refreshHistoryButton">${localize('webviews.queryBuilder.refreshHistoryButton', 'Refresh History')}</button>
        <label class="toggle"><input id="rawToggle" type="checkbox" /> ${localize('webviews.queryBuilder.rawJsonLabel', 'Raw JSON')}</label>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section class="panel">
      <h2>${localize('webviews.queryBuilder.resultsHeading', 'Results')}</h2>
      <div id="resultSummary" class="summary" role="status" aria-live="polite"></div>
      <div id="tableContainer" class="table-wrap"></div>
      <pre id="rawContainer" class="raw hidden"></pre>
    </section>

    <section class="panel">
      <h2>${localize('webviews.queryBuilder.historyHeading', 'History (Last Requests)')}</h2>
      <div id="historyContainer" class="history"></div>
    </section>
  </div>

  ${i18nScript}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
