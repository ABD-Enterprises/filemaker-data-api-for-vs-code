import { vi } from 'vitest';

import {
  FileMakerChatHandler,
  type ChatToolCore,
  type ChatModelLike,
  type ChatRequestLike,
  type ChatStreamLike,
  type ChatTokenLike
} from '../../../../src/ai/chat/chatParticipant';
import { makeHarness, type Harness } from '../harness';

export const REQUIRED = Symbol('required');

export interface Captured {
  markdown: string[];
  buttons: Array<{ command: string; title: string; arguments?: unknown[] }>;
  progress: string[];
}

export function makeStream(): { stream: ChatStreamLike; captured: Captured } {
  const captured: Captured = { markdown: [], buttons: [], progress: [] };
  return {
    captured,
    stream: {
      markdown: (value) => {
        // The real stream takes a string or a MarkdownString; the participant must only ever pass a string.
        expectString(value);
        captured.markdown.push(value);
      },
      button: (command) => void captured.buttons.push(command),
      progress: (value) => void captured.progress.push(value)
    }
  };
}

function expectString(value: unknown): void {
  if (typeof value !== 'string') {
    throw new Error('markdown() must get a plain string, never a MarkdownString');
  }
}

export function makeToken(): { token: ChatTokenLike; cancel: () => void } {
  const listeners = new Set<() => void>();
  const token: ChatTokenLike = {
    isCancellationRequested: false,
    onCancellationRequested: (listener) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    }
  };
  return {
    token,
    cancel: () => {
      (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
      for (const listener of [...listeners]) listener();
    }
  };
}

export interface ToolCallPart {
  callId: string;
  name: string;
  input: unknown;
}

export const toolCall = (name: string, input: unknown): ToolCallPart => ({
  callId: 'c1',
  name,
  input
});

export function makeModel(
  parts: unknown[] | (() => AsyncIterable<unknown>)
): ChatModelLike & { sendRequest: ReturnType<typeof vi.fn> } {
  return {
    sendRequest: vi.fn(async () => ({
      stream:
        typeof parts === 'function'
          ? parts()
          : (async function* () {
              for (const part of parts) yield part;
            })()
    }))
  };
}

export interface ChatTestBed {
  h: Harness;
  invoked: Array<{ name: string; input: unknown; context: unknown }>;
  handler: FileMakerChatHandler;
  run(
    request: ChatRequestLike,
    token?: ChatTokenLike
  ): Promise<{
    result: Awaited<ReturnType<FileMakerChatHandler['handle']>>;
    text: string;
    captured: Captured;
  }>;
}

/** The real tool core behind the participant, with every `invoke` recorded. */
export function makeChatBed(options?: Parameters<typeof makeHarness>[0]): ChatTestBed {
  const h = makeHarness(options);
  const invoked: ChatTestBed['invoked'] = [];
  const service: ChatToolCore = {
    invoke: async (name, input, context) => {
      invoked.push({ name, input, context });
      return h.service.invoke(name, input, context);
    },
    isKilled: () => h.service.isKilled(),
    unavailableReason: () => h.service.unavailableReason()
  };
  const handler = new FileMakerChatHandler(service, {
    userMessage: (text) => ({ role: 'user', text }),
    requiredToolMode: REQUIRED
  });
  return {
    h,
    invoked,
    handler,
    run: async (request, token) => {
      const { stream, captured } = makeStream();
      const result = await handler.handle(request, stream, token ?? makeToken().token);
      return { result, text: captured.markdown.join(''), captured };
    }
  };
}

/**
 * Checks what an attacker controls cannot become Markdown: outside the fenced blocks there is no
 * link, image, HTML or command URI, and no fence is left open or closed early.
 */
export function assertSafeMarkdown(markdown: string, forbidden: readonly string[] = []): void {
  const outside: string[] = [];
  let open: string | undefined;
  for (const line of markdown.split('\n')) {
    if (open === undefined) {
      const match = /^(`{3,})text$/.exec(line);
      if (match) {
        open = match[1] as string;
      } else {
        outside.push(line);
      }
    } else if (line === open) {
      open = undefined;
    } else if (/^`{3,}\s*$/.test(line) && line.length >= open.length) {
      throw new Error(`a line inside a fence closes it early: ${line}`);
    }
  }
  if (open !== undefined) {
    throw new Error('a fence was left open');
  }
  const rest = outside.join('\n');
  // Constants of the extension use inline code; none of them has a link, an image, HTML or a command URI.
  for (const pattern of [
    /\]\(/,
    /!\[/,
    /</,
    />/,
    /command:/i,
    /https?:\/\//i,
    /\bjavascript:/i,
    /\bdata:/i
  ]) {
    if (pattern.test(rest)) {
      throw new Error(`markdown outside a fence matches ${pattern}: ${rest.slice(0, 200)}`);
    }
  }
  for (const word of forbidden) {
    if (rest.includes(word)) {
      throw new Error(`untrusted text "${word}" appears outside a fence`);
    }
  }
  // Every line inside fences is a single physical line of text: control characters were escaped.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f\u202e\u200b\u2028\u2029]/.test(markdown)) {
    throw new Error('a control, bidi or separator character reached the output');
  }
}
