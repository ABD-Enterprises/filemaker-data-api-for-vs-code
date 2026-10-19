import { redactString } from '../../utils/redact';
import { AiToolError, type AiCallContext, type AiToolService } from '../aiToolService';
import { findToolDefinition } from '../aiToolDefinitions';
import { scrubGenericText } from '../aiText';
import { MAX_FIND_FIELDS_IN_PROMPT, buildFindPrompt } from './chatPrompt';
import {
  capOutput,
  describedFieldNames,
  fence,
  renderDescribe,
  renderError,
  renderExplain,
  renderLayouts,
  renderRecords,
  safeLine
} from './chatText';

/** Audit name for every call made from chat (the core writes it as the claimed client). */
export const CHAT_CLIENT_NAME = 'chat participant';
/** A request line longer than this is refused: it is typed by a person and goes to the model. */
export const MAX_PROMPT_CHARS = 1000;
const MAX_STREAM_PARTS = 200;
const MAX_REQUEST_JSON_CHARS = 2000;
export const FIND_LIMIT = 10;

export const OPEN_SETTINGS_COMMAND = 'workbench.action.openGlobalSettings';
export const KILL_SWITCH_COMMAND_ID = 'filemakerDataApiTools.toggleAiKillSwitch';

/** The part of the tool core the participant may use: it adds no policy of its own. */
export type ChatToolCore = Pick<AiToolService, 'invoke' | 'isKilled' | 'unavailableReason'>;

export interface ChatStreamLike {
  /** A plain string: never a trusted MarkdownString, so command links cannot run. */
  markdown(value: string): void;
  button(command: { command: string; title: string; arguments?: unknown[] }): void;
  progress(value: string): void;
}

export interface ChatTokenLike {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ChatModelLike {
  sendRequest(
    messages: unknown[],
    options: {
      tools: Array<{ name: string; description: string; inputSchema?: object }>;
      toolMode: unknown;
    },
    token: ChatTokenLike
  ): Promise<{ stream: AsyncIterable<unknown> }>;
}

export interface ChatRequestLike {
  command?: string;
  prompt: string;
  model?: ChatModelLike;
}

/** What the participant needs from VS Code, injected so the logic is testable without it. */
export interface ChatPlatform {
  userMessage(text: string): unknown;
  /** `LanguageModelChatToolMode.Required` */
  requiredToolMode: unknown;
}

export interface ChatResultLike {
  metadata: { command: string; outcome: 'ok' | 'refused' | 'off' | 'cancelled' | 'error' };
}

type Obj = Record<string, unknown>;

/** The slash commands this participant answers: the manifest must declare exactly these (a test checks). */
export const CHAT_COMMANDS: readonly string[] = ['layouts', 'describe', 'find', 'explain', 'help'];

const HELP = [
  '**@filemaker** reads a FileMaker database through the same AI safety rules as the AI tools (read only):',
  '- `/layouts` lists the layouts',
  '- `/describe LAYOUT` shows the fields of a layout',
  '- `/find LAYOUT criteria` finds records: `Name==Ada; City=Paris` is sent as written, other text is turned into a search by the language model you chose, then checked by this extension',
  '- `/explain CODE` explains a FileMaker error code (without a code, the last error seen here)',
  '',
  'Nothing is changed by this participant. AI tools must be switched on in your user settings (`filemaker.ai.enabled`) and a connection chosen for AI. Layouts ask for your approval once per session.'
].join('\n');

const OFF = [
  '**AI tools are off.** To use `@filemaker`:',
  '1. Turn on `filemaker.ai.enabled` in your **user** settings (a workspace setting cannot).',
  '2. Run **FileMaker: Set AI Access for Connection** and choose **Read**.',
  '3. Ask again.'
].join('\n');

/** A leading layout name from the request: quoted, or the longest usable name that starts the text. */
export function splitLayout(
  text: string,
  layouts: readonly string[]
): { layout: string; rest: string } | undefined {
  const trimmed = text.trim();
  const quote = /^"([^"]{1,64})"\s*(.*)$/s.exec(trimmed);
  if (quote) {
    return layouts.includes(quote[1] as string)
      ? { layout: quote[1] as string, rest: (quote[2] as string).trim() }
      : undefined;
  }
  const match = [...layouts]
    .sort((a, b) => b.length - a.length)
    .find((name) => name.length > 0 && (trimmed === name || trimmed.startsWith(`${name} `)));
  return match === undefined
    ? undefined
    : { layout: match, rest: trimmed.slice(match.length).trim() };
}

/** `Field=value; Other==value` with every field known: a request built without the model. */
export function parseKeyValue(
  text: string,
  known: ReadonlySet<string>
): Record<string, string> | undefined {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of text.split(';')) {
    const match = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/s.exec(part);
    if (!match || !known.has(match[1] as string) || (match[1] as string) in fields) {
      return undefined;
    }
    fields[match[1] as string] = match[2] as string;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function isToolCall(part: unknown): part is { name: string; input: unknown } {
  return (
    typeof part === 'object' &&
    part !== null &&
    typeof (part as Obj).name === 'string' &&
    'input' in part &&
    'callId' in part
  );
}

/**
 * The @filemaker handler (ADR-0005): a thin front end. Every read goes through
 * `AiToolService.invoke`, so settings, trust, offline mode, the kill switch, the connection's
 * AI access, layout approval, hidden fields and quotas apply unchanged. Only read tools are ever
 * named here. Nothing is rendered outside a fence except constants and numbers.
 */
export class FileMakerChatHandler {
  private lastErrorCode: number | undefined;

  public constructor(
    private readonly service: ChatToolCore,
    private readonly platform: ChatPlatform
  ) {}

  public async handle(
    request: ChatRequestLike,
    stream: ChatStreamLike,
    token: ChatTokenLike
  ): Promise<ChatResultLike> {
    const command = request.command ?? '';
    const done = (outcome: ChatResultLike['metadata']['outcome']): ChatResultLike => ({
      metadata: { command, outcome }
    });
    const out = (markdown: string): void => stream.markdown(capOutput(markdown));

    if (token.isCancellationRequested) {
      out('The request was cancelled.');
      return done('cancelled');
    }
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      if (command === 'help' || command === '') {
        out(command === '' ? `Pick a command.\n\n${HELP}` : HELP);
        return done('ok');
      }
      if (!CHAT_COMMANDS.includes(command)) {
        out(HELP);
        return done('refused');
      }
      if (request.prompt.length > MAX_PROMPT_CHARS) {
        out(`That request is longer than ${MAX_PROMPT_CHARS} characters. Shorten it.`);
        return done('refused');
      }

      // The core decides; this only gives the user the right first step when AI is off.
      if (this.service.isKilled()) {
        out(
          '**AI tools are switched off for this session** (the kill switch). Switching them back on asks you first.'
        );
        stream.button({ command: KILL_SWITCH_COMMAND_ID, title: 'Switch AI Tools Back On' });
        return done('off');
      }
      const reason = this.service.unavailableReason();
      if (reason !== undefined) {
        // `reason` can come from a policy file: it is shown as data.
        if (reason.includes('filemaker.ai.enabled')) {
          out([OFF, 'Right now:', fence([safeLine(reason, 300)])].join('\n\n'));
          stream.button({
            command: OPEN_SETTINGS_COMMAND,
            title: 'Open AI Settings',
            arguments: [{ query: 'filemaker.ai' }]
          });
        } else {
          out(
            ['**AI tools are not available right now.**', fence([safeLine(reason, 300)])].join(
              '\n\n'
            )
          );
        }
        return done('off');
      }

      const context: AiCallContext = { signal: controller.signal, client: CHAT_CLIENT_NAME };
      switch (command) {
        case 'layouts':
          out(renderLayouts(await this.call('fm_list_layouts', {}, context)));
          break;
        case 'describe':
          await this.describe(request.prompt, out, context);
          break;
        case 'explain':
          await this.explain(request.prompt, out, context);
          break;
        default:
          await this.find(request, out, stream, token, context);
      }
      return done('ok');
    } catch (error) {
      if (controller.signal.aborted || token.isCancellationRequested) {
        out('The request was cancelled.');
        return done('cancelled');
      }
      out(renderError(this.safeMessage(error)));
      return done(
        error instanceof AiToolError && error.outcome === 'refused' ? 'refused' : 'error'
      );
    } finally {
      subscription.dispose();
    }
  }

  private async call(tool: string, input: unknown, context: AiCallContext): Promise<unknown> {
    try {
      return await this.service.invoke(tool, input, context);
    } catch (error) {
      const code = /FileMaker error (\d{1,5})/.exec(
        error instanceof Error ? error.message : ''
      )?.[1];
      if (code !== undefined) {
        this.lastErrorCode = Number(code);
      }
      throw error;
    }
  }

  /** Messages of the tool core are already free of the server address and secrets; anything else is not shown. */
  private safeMessage(error: unknown): string {
    if (error instanceof AiToolError) {
      return scrubGenericText(redactString(error.message));
    }
    return 'The request failed unexpectedly.';
  }

  private async describe(
    prompt: string,
    out: (text: string) => void,
    context: AiCallContext
  ): Promise<void> {
    const layout = prompt
      .trim()
      .replace(/^"(.*)"$/s, '$1')
      .trim();
    if (layout === '') {
      out('Give a layout name: `/describe LAYOUT`. `/layouts` lists them.');
      return;
    }
    out(renderDescribe(await this.call('fm_describe_layout', { layout }, context)));
  }

  private async explain(
    prompt: string,
    out: (text: string) => void,
    context: AiCallContext
  ): Promise<void> {
    const given = /\b(\d{1,5})\b/.exec(prompt)?.[1];
    const code = given !== undefined ? Number(given) : this.lastErrorCode;
    if (code === undefined) {
      out(
        'Give an error code: `/explain 802`. Without a code, `/explain` uses the last FileMaker error seen here, and none has been seen yet.'
      );
      return;
    }
    out(renderExplain(await this.call('fm_explain_error', { code }, context)));
  }

  private async find(
    request: ChatRequestLike,
    out: (text: string) => void,
    stream: ChatStreamLike,
    token: ChatTokenLike,
    context: AiCallContext
  ): Promise<void> {
    const text = request.prompt.trim();
    if (text === '') {
      out(
        'Give a layout and what to find: `/find LAYOUT Name==Ada; City=Paris` or `/find LAYOUT people in Paris named Ada`.'
      );
      return;
    }

    const listing = (await this.call('fm_list_layouts', {}, context)) as {
      layouts?: Array<{ name?: unknown; usable?: unknown }>;
    };
    const usable = (listing.layouts ?? []).flatMap((item) =>
      item.usable === true && typeof item.name === 'string' ? [item.name] : []
    );
    const split = splitLayout(text, usable);
    if (!split) {
      out(
        'Start with the name of a layout (`/layouts` lists them), in quotes if it has special characters: `/find "My Layout" Name==Ada`.'
      );
      return;
    }
    if (split.rest === '') {
      out('Say what to find after the layout name: `/find LAYOUT Name==Ada` or in plain words.');
      return;
    }

    // Field names come from the layout (and ask for the user's approval of the layout).
    const names = describedFieldNames(
      await this.call('fm_describe_layout', { layout: split.layout }, context)
    );
    const direct = parseKeyValue(split.rest, new Set(names));

    let input: Obj;
    if (direct) {
      input = { layout: split.layout, requests: [{ fields: direct }], limit: FIND_LIMIT };
    } else {
      stream.progress('Asking the language model to build the find request...');
      input = await this.askModel(request, split.layout, names, split.rest, token);
    }

    out(
      [
        'Find request (checked by this extension before it ran):',
        fence([safeLine(JSON.stringify(input), MAX_REQUEST_JSON_CHARS)])
      ].join('\n\n')
    );
    out(renderRecords(await this.call('fm_find_records', input, context)));
  }

  private async askModel(
    request: ChatRequestLike,
    layout: string,
    names: string[],
    wanted: string,
    token: ChatTokenLike
  ): Promise<Obj> {
    if (!request.model || typeof request.model.sendRequest !== 'function') {
      throw new AiToolError(
        'No language model is selected for this chat. Write the criteria as `Field=value; Other==value` or choose a model.'
      );
    }
    const definition = findToolDefinition('fm_find_records');
    if (!definition || definition.kind !== 'read') {
      throw new AiToolError('The find tool is not available.');
    }

    let calls: Array<{ name: string; input: unknown }> = [];
    try {
      const response = await request.model.sendRequest(
        [
          this.platform.userMessage(
            buildFindPrompt({
              layout,
              fields: names.slice(0, MAX_FIND_FIELDS_IN_PROMPT),
              request: wanted
            })
          )
        ],
        // The only tool offered: a read. No write or script tool is ever listed here.
        {
          tools: [
            {
              name: definition.name,
              description: definition.modelDescription,
              inputSchema: definition.inputSchema
            }
          ],
          toolMode: this.platform.requiredToolMode
        },
        token
      );
      let seen = 0;
      for await (const part of response.stream) {
        seen += 1;
        if (token.isCancellationRequested || seen > MAX_STREAM_PARTS) {
          break;
        }
        if (isToolCall(part)) {
          calls.push(part);
        }
        // Text the model writes is not shown: only a validated tool call can lead to anything.
      }
    } catch (error) {
      if (token.isCancellationRequested) {
        throw error;
      }
      throw new AiToolError(
        `The language model could not be used: ${scrubGenericText(redactString(error instanceof Error ? error.message : 'unknown error')).slice(0, 200)}`,
        'error'
      );
    }

    calls = calls.slice(0, 10);
    if (calls.length === 0) {
      throw new AiToolError(
        'The model did not build a find request. Try again, or write the criteria as `Field=value`.'
      );
    }
    const first = calls[0] as { name: string; input: unknown };
    if (calls.some((call) => call.name !== definition.name)) {
      throw new AiToolError(
        'The model asked for a tool this participant does not offer. Nothing was run.'
      );
    }
    if (typeof first.input !== 'object' || first.input === null || Array.isArray(first.input)) {
      throw new AiToolError(
        'The model sent a find request that is not an object. Nothing was run.'
      );
    }
    // The layout is the one the user named, whatever the model wrote. Everything else is validated by the tool core.
    return { ...(first.input as Obj), layout };
  }
}
