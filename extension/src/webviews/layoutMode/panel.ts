import * as vscode from 'vscode';

import {
  migrateLayoutDefinition,
  type BehaviorBinding,
  type LayoutDefinition
} from '../../fmweb/layoutSchema';

import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { ConnectionProfile } from '../../types/fm';
import type { FmWebProjectService } from '../../services/fmWebProjectService';
import { buildWebviewCsp, createNonce } from '../common/csp';
import {
  getOptionalBooleanField,
  getStringField,
  toRecord
} from '../common/messageValidation';
import { executeBehaviorBinding, type BehaviorExecutionResult } from './behaviorExecution';
import { isFeatureEnabled, isOfflineModeOn } from '../../utils/policySetting';
import { versionFooterHtml } from '../../about/runtimeVersion';

interface LayoutModeOpenOptions {
  layoutId?: string;
  /** Applies the enterprise role/feature policy for running scripts; resolves false when blocked. */
  assertScriptRunAllowed: () => Promise<boolean>;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'saveLayout'; payload: { layout: LayoutDefinition; autosave?: boolean } }
  | {
      type: 'executeBehavior';
      payload: {
        layoutId: string;
        layoutName: string;
        fmLayoutName?: string;
        objectId: string;
        objectName: string;
        behavior: BehaviorBinding;
      };
    };

export class LayoutModePanel {
  private static currentPanel: LayoutModePanel | undefined;

  private pendingLayoutId: string | undefined;
  private assertScriptRunAllowed: () => Promise<boolean>;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly fmWebProjectService: FmWebProjectService,
    private readonly profileStore: ProfileStore,
    private readonly fmClient: FMClient,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    options: LayoutModeOpenOptions
  ) {
    this.pendingLayoutId = options?.layoutId;
    this.assertScriptRunAllowed = options.assertScriptRunAllowed;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => {
      LayoutModePanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    fmWebProjectService: FmWebProjectService,
    profileStore: ProfileStore,
    fmClient: FMClient,
    logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    options: LayoutModeOpenOptions
  ): void {
    const column = vscode.ViewColumn.One;

    if (LayoutModePanel.currentPanel) {
      LayoutModePanel.currentPanel.panel.reveal(column);
      LayoutModePanel.currentPanel.pendingLayoutId = options?.layoutId;
      LayoutModePanel.currentPanel.assertScriptRunAllowed = options.assertScriptRunAllowed;
      void LayoutModePanel.currentPanel.sendInitState();
      return;
    }

    const panel = vscode.window.createWebviewPanel('filemakerLayoutMode', 'FileMaker Layout Mode', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'layoutMode', 'ui')
      ]
    });

    LayoutModePanel.currentPanel = new LayoutModePanel(
      panel,
      context,
      fmWebProjectService,
      profileStore,
      fmClient,
      logger,
      options
    );
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = this.parseMessage(rawMessage);
    if (!message) {
      return;
    }

    switch (message.type) {
      case 'ready':
        await this.sendInitState();
        break;
      case 'saveLayout':
        await this.handleSaveLayout(message.payload.layout, message.payload.autosave ?? false);
        break;
      case 'executeBehavior':
        await this.handleExecuteBehavior(message.payload);
        break;
      default:
        break;
    }
  }

  private async sendInitState(): Promise<void> {
    try {
      const project = await this.fmWebProjectService.ensureProjectInitialized();
      const loaded = await this.fmWebProjectService.loadOrCreateLayout(this.pendingLayoutId);
      const metadataCache = await this.fmWebProjectService.loadMetadataCache();
      const availableFields = await this.fmWebProjectService.getAvailableFields(loaded.layout.fmLayoutName);

      await this.panel.webview.postMessage({
        type: 'init',
        payload: {
          layout: loaded.layout,
          availableFields,
          scripts: metadataCache?.scripts ?? [],
          projectName: project.name
        }
      });

      this.pendingLayoutId = undefined;
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private async handleSaveLayout(layout: LayoutDefinition, autosave: boolean): Promise<void> {
    try {
      const normalized = migrateLayoutDefinition(layout);
      await this.fmWebProjectService.saveLayout(normalized);

      await this.panel.webview.postMessage({
        type: 'saveResult',
        payload: {
          ok: true,
          message: autosave ? 'Autosaved layout.' : 'Layout saved.'
        }
      });
    } catch (error) {
      this.logger.error('Failed to save layout from Layout Mode panel.', { error });
      await this.panel.webview.postMessage({
        type: 'saveResult',
        payload: {
          ok: false,
          message: this.formatError(error)
        }
      });
    }
  }

  private async handleExecuteBehavior(payload: {
    layoutId: string;
    layoutName: string;
    fmLayoutName?: string;
    objectId: string;
    objectName: string;
    behavior: BehaviorBinding;
  }): Promise<void> {
    try {
      const profile = await this.resolveActiveProfile();

      if (payload.behavior.type === 'runScript' && profile) {
        const refusal = await this.refuseScriptRun(payload, profile);
        if (refusal) {
          await this.postBehaviorResult({ ok: false, action: 'runScript', stub: false, message: refusal });
          return;
        }
      }

      const result = await executeBehaviorBinding({
        behavior: payload.behavior,
        objectName: payload.objectName,
        layoutName: payload.layoutName,
        fmLayoutName: payload.fmLayoutName,
        profile,
        runScript: async (activeProfile, request) => this.fmClient.runScript(activeProfile, request)
      });

      if (!result.ok) {
        this.logger.warn('Layout behavior execution reported a non-ok result.', {
          payload,
          result
        });
      }

      await this.postBehaviorResult(result);
    } catch (error) {
      this.logger.error('Failed to execute layout behavior binding.', { error, payload });
      await this.postBehaviorResult({
        ok: false,
        action: payload.behavior.type ?? 'unknown',
        stub: false,
        message: this.formatError(error)
      });
    }
  }

  /**
   * A layout file arrives with the repository, so a `runScript` binding is the repository
   * asking to run a script on the user's FileMaker server. It gets the same checks as the
   * Script Runner, then an explicit confirmation naming the script, parameter and
   * connection. Returns why it must not run, or undefined when the user said yes.
   */
  private async refuseScriptRun(
    payload: { layoutName: string; fmLayoutName?: string; objectName: string; behavior: BehaviorBinding },
    profile: ConnectionProfile
  ): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) {
      return 'Running scripts from Layout Mode needs a trusted workspace.';
    }

    const configuration = vscode.workspace.getConfiguration('filemaker');
    if (!isFeatureEnabled(configuration, 'features.scriptRunner.enabled')) {
      return 'Script running is disabled by the setting filemaker.features.scriptRunner.enabled.';
    }
    if (isOfflineModeOn(configuration)) {
      return 'Offline mode is enabled; scripts cannot run.';
    }
    if (!(await this.assertScriptRunAllowed())) {
      return 'Running scripts is not allowed by your enterprise policy.';
    }

    // Used exactly as stored: a space can be part of a script or layout name, and a parameter is passed verbatim.
    const scriptName = payload.behavior.scriptName ?? '';
    const parameter = payload.behavior.parameter ?? '';
    const layout = payload.fmLayoutName ?? payload.layoutName ?? '';
    const target = profile.authMode === 'proxy' ? profile.proxyEndpoint : profile.serverUrl;
    const project = await this.fmWebProjectService.readProjectConfig();
    const userProfileId = this.profileStore.getActiveProfileId();
    const chosenByProject = Boolean(project?.activeProfileId) && project?.activeProfileId !== userProfileId;

    const answer = await vscode.window.showWarningMessage(
      [
        `Run the script "${oneLine(scriptName, 120)}" on the FileMaker layout "${oneLine(layout, 120)}"?`,
        `Parameter: ${parameter ? oneLine(parameter, 200) : '(none)'}`,
        `Connection: ${oneLine(profile.name, 80)} (${oneLine(target ?? profile.serverUrl, 200)})`,
        chosenByProject
          ? 'The project file in this workspace chose this connection; it is not your active connection.'
          : '',
        'This request comes from the layout file in your workspace, not from you.'
      ]
        .filter(Boolean)
        .join('\n\n'),
      { modal: true },
      'Run script'
    );

    return answer === 'Run script' ? undefined : 'Script run cancelled.';
  }

  private async resolveActiveProfile(): Promise<Awaited<ReturnType<ProfileStore['getProfile']>> | undefined> {
    const project = await this.fmWebProjectService.readProjectConfig();
    const profileId = project?.activeProfileId ?? this.profileStore.getActiveProfileId();
    if (!profileId) {
      return undefined;
    }

    return this.profileStore.getProfile(profileId);
  }

  private async postBehaviorResult(result: BehaviorExecutionResult): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'behaviorResult',
      payload: result
    });
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'error',
      payload: {
        message
      }
    });
  }

  private parseMessage(rawMessage: unknown): IncomingMessage | undefined {
    const message = toRecord(rawMessage);
    if (!message) {
      return undefined;
    }

    const type = typeof message.type === 'string' ? message.type : undefined;
    if (!type) {
      return undefined;
    }

    if (type === 'ready') {
      return { type: 'ready' };
    }

    if (type === 'saveLayout') {
      const payload = toRecord(message.payload);
      if (!payload) {
        return undefined;
      }

      const layoutValue = payload.layout;
      if (!layoutValue || typeof layoutValue !== 'object' || Array.isArray(layoutValue)) {
        return undefined;
      }

      const autosave = getOptionalBooleanField(payload, 'autosave');

      return {
        type: 'saveLayout',
        payload: {
          layout: layoutValue as LayoutDefinition,
          autosave
        }
      };
    }

    if (type === 'executeBehavior') {
      const payload = toRecord(message.payload);
      if (!payload) {
        return undefined;
      }

      const layoutId = getStringField(payload, 'layoutId');
      const layoutName = getStringField(payload, 'layoutName');
      const objectId = getStringField(payload, 'objectId');
      const objectName = getStringField(payload, 'objectName');
      const behavior = parseBehaviorBinding(payload.behavior);

      if (!layoutId || !layoutName || !objectId || !objectName || !behavior) {
        return undefined;
      }

      return {
        type: 'executeBehavior',
        payload: {
          layoutId,
          layoutName,
          fmLayoutName: getStringField(payload, 'fmLayoutName'),
          objectId,
          objectName,
          behavior
        }
      };
    }

    return undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'layoutMode', 'ui', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'layoutMode', 'ui', 'index.css')
    );

    const csp = buildWebviewCsp(webview, {
      nonce
    });

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>FileMaker Layout Mode</title>
  </head>
  <body>
    <div id="root"></div>
    ${versionFooterHtml()}
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unexpected Layout Mode error.';
  }
}

const BEHAVIOR_TYPES = new Set<Exclude<BehaviorBinding['type'], undefined>>([
  'runScript',
  'goToWebLayout',
  'goToFmLayout',
  'openUrl',
  'showDialog'
]);

function parseBehaviorBinding(value: unknown): BehaviorBinding | undefined {
  const behavior = toRecord(value);
  if (!behavior) {
    return undefined;
  }

  const typeRaw = getStringField(behavior, 'type');
  const type = typeRaw && BEHAVIOR_TYPES.has(typeRaw as Exclude<BehaviorBinding['type'], undefined>)
    ? (typeRaw as Exclude<BehaviorBinding['type'], undefined>)
    : undefined;

  return {
    type,
    scriptName: getStringField(behavior, 'scriptName'),
    targetLayoutId: getStringField(behavior, 'targetLayoutId'),
    targetFmLayoutName: getStringField(behavior, 'targetFmLayoutName'),
    url: getStringField(behavior, 'url'),
    dialogId: getStringField(behavior, 'dialogId'),
    parameter: getStringField(behavior, 'parameter')
  };
}

/** Collapses line breaks and control characters so text from a layout file cannot add lines to a prompt. */
function oneLine(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
