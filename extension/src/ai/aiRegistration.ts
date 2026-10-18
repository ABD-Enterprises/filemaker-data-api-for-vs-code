import * as vscode from 'vscode';

import type { AiAccess } from '../types/fm';
import type { AiSettings } from './aiSettings';
import { AI_TOOL_DEFINITIONS, type AiToolDefinition } from './aiToolDefinitions';
import type { AiToolService } from './aiToolService';

export const KILL_SWITCH_COMMAND = 'filemakerDataApiTools.toggleAiKillSwitch';
export const SHOW_ACTIVITY_COMMAND = 'filemakerDataApiTools.showAiActivity';
export const SET_ACCESS_COMMAND = 'filemakerDataApiTools.setAiAccess';
export const NEW_SESSION_COMMAND = 'filemakerDataApiTools.newAiSession';

/** The part of `vscode.lm` this module uses; absent on an editor that predates the API. */
export interface LanguageModelApi {
  registerTool(name: string, tool: vscode.LanguageModelTool<object>): vscode.Disposable;
}

export function getLanguageModelApi(): LanguageModelApi | undefined {
  try {
    const lm = (vscode as unknown as { lm?: Partial<LanguageModelApi> }).lm;
    return typeof lm?.registerTool === 'function' ? (lm as LanguageModelApi) : undefined;
  } catch {
    // An editor or test host without the API.
    return undefined;
  }
}

export interface AiStatusModel {
  text: string;
  tooltip: string;
}

/** Pure render of the status-bar item: `AI: off | read-only | writes on | scripts on`. */
export function computeAiStatus(
  tools: readonly AiToolDefinition[],
  settings: Pick<AiSettings, 'enabled'>,
  state: { killed: boolean; recordsUsed: number; recordQuota: number; writesUsed: number; writeCap: number },
  account: string | undefined,
  /** What the chosen connection allows; the state shown is the effective one. */
  access: AiAccess | undefined
): AiStatusModel {
  if (state.killed) {
    return { text: '$(circle-slash) AI: off', tooltip: 'AI tools are switched off for this session. Click to switch them back on.' };
  }
  if (!settings.enabled || tools.length === 0) {
    return { text: '$(circle-slash) AI: off', tooltip: 'AI tools are not available (filemaker.ai.enabled, policy, trust or offline mode).' };
  }

  if (access === undefined || access === 'none') {
    return {
      text: '$(circle-slash) AI: off (connection not enabled)',
      tooltip: 'The connection chosen for AI is not enabled. Run "FileMaker: Set AI Access for Connection".'
    };
  }

  // The connection decides: a profile set to "read" never allows writes, whatever the settings say.
  const mode =
    access === 'write' && tools.some((tool) => tool.kind === 'script')
      ? 'scripts on'
      : access === 'write' && tools.some((tool) => tool.kind === 'write')
        ? 'writes on'
        : 'read-only';
  return {
    text: `$(sparkle) AI: ${mode}`,
    tooltip: [
      `AI tools: ${mode}. Click to switch them all off.`,
      `Records read this session: ${state.recordsUsed} of ${state.recordQuota}`,
      `Write attempts this session: ${state.writesUsed} of ${state.writeCap}`,
      account ? `FileMaker account used: ${account.replace(/[\r\n]+/g, ' ').slice(0, 64)}` : ''
    ]
      .filter((line) => line.length > 0)
      .join('\n')
  };
}

/**
 * Registers a language-model tool for every definition the core currently offers, and
 * removes the ones it no longer offers. Run `refresh()` when settings, trust, offline mode,
 * a profile or the kill switch change. This is a transport only: it passes the input to
 * `AiToolService.invoke` and the result back, and adds no policy. A tool is also checked
 * inside `invoke`, so a call that arrives after the tool was withdrawn still fails.
 */
export class AiToolsController implements vscode.Disposable {
  private readonly registered = new Map<string, vscode.Disposable>();
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changed.event;

  public constructor(
    private readonly service: AiToolService,
    private readonly options: {
      lm?: LanguageModelApi;
      setContext?: (key: string, value: boolean) => Thenable<unknown> | void;
    } = { lm: getLanguageModelApi() }
  ) {}

  public registeredNames(): string[] {
    return [...this.registered.keys()].sort();
  }

  public refresh(): void {
    const offered = new Map(this.service.listTools().map((tool) => [tool.name, tool]));

    for (const [name, disposable] of [...this.registered]) {
      if (!offered.has(name)) {
        disposable.dispose();
        this.registered.delete(name);
      }
    }

    const lm = this.options.lm;
    if (lm) {
      for (const [name, definition] of offered) {
        if (!this.registered.has(name)) {
          this.registered.set(name, lm.registerTool(name, this.toolFor(definition)));
        }
      }
    }

    const kinds = new Set([...offered.values()].map((tool) => tool.kind));
    void this.options.setContext?.('filemaker.ai.active', offered.size > 0);
    void this.options.setContext?.('filemaker.ai.writes', kinds.has('write'));
    void this.options.setContext?.('filemaker.ai.scripts', kinds.has('script'));
    this.changed.fire();
  }

  public dispose(): void {
    for (const disposable of this.registered.values()) {
      disposable.dispose();
    }
    this.registered.clear();
    this.changed.dispose();
  }

  private toolFor(definition: AiToolDefinition): vscode.LanguageModelTool<object> {
    return {
      // Side-effect free. Deliberately no `confirmationMessages`: VS Code's own prompt can be
      // set to "always allow", so it is not a control. Writes ask inside `invoke`.
      prepareInvocation: () => ({ invocationMessage: definition.userDescription }),
      invoke: async (options, token) => {
        const controller = new AbortController();
        const subscription = token?.onCancellationRequested?.(() => controller.abort());
        try {
          const result = await this.service.invoke(definition.name, options.input, { signal: controller.signal });
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
        } finally {
          subscription?.dispose();
        }
      }
    };
  }
}

/** The names a manifest must declare: used by the contract test. */
export const AI_TOOL_NAMES: readonly string[] = AI_TOOL_DEFINITIONS.map((tool) => tool.name);
