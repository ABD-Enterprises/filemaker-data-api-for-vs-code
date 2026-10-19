import * as vscode from 'vscode';

import type { AiToolService } from '../aiToolService';
import {
  FileMakerChatHandler,
  type ChatModelLike,
  type ChatStreamLike,
  type ChatTokenLike
} from './chatParticipant';

/** Must equal `contributes.chatParticipants[0].id` and the `onChatParticipant:` activation event (a test checks). */
export const CHAT_PARTICIPANT_ID = 'filemaker-data-api-tools.filemaker';

/** The part of `vscode.chat` used here; absent on an editor that predates the Chat Participant API. */
export interface ChatApi {
  createChatParticipant(
    id: string,
    handler: (
      request: vscode.ChatRequest,
      context: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => Promise<vscode.ChatResult | void>
  ): vscode.ChatParticipant;
}

export function getChatApi(): ChatApi | undefined {
  try {
    const chat = (vscode as unknown as { chat?: Partial<ChatApi> }).chat;
    return typeof chat?.createChatParticipant === 'function' ? (chat as ChatApi) : undefined;
  } catch {
    // An editor or test host without the API.
    return undefined;
  }
}

/**
 * Registers `@filemaker`. It is a front end to the tool core and keeps no policy: when AI is off,
 * the kill switch is on, the workspace is untrusted or the connection is not enabled, the core
 * refuses and the handler says so on every request. Returns undefined when the editor has no chat API.
 */
export function registerChatParticipant(options: {
  service: AiToolService;
  chat?: ChatApi;
}): vscode.Disposable | undefined {
  const chat = options.chat ?? getChatApi();
  if (!chat) {
    return undefined;
  }
  const handler = new FileMakerChatHandler(options.service, {
    userMessage: (text) => vscode.LanguageModelChatMessage.User(text),
    requiredToolMode: vscode.LanguageModelChatToolMode?.Required
  });
  return chat.createChatParticipant(
    CHAT_PARTICIPANT_ID,
    async (request, _context, stream, token) => {
      const result = await handler.handle(
        {
          command: request.command,
          prompt: request.prompt,
          model: request.model as unknown as ChatModelLike
        },
        // `stream.markdown` gets plain strings only, so nothing here can be a trusted MarkdownString.
        stream as unknown as ChatStreamLike,
        token as unknown as ChatTokenLike
      );
      return result;
    }
  );
}
