/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelChatMessage: { User: (text: string) => ({ role: 'user', text }) }
}));

import { CHAT_COMMANDS } from '../../../../src/ai/chat/chatParticipant';
import {
  CHAT_PARTICIPANT_ID,
  getChatApi,
  registerChatParticipant
} from '../../../../src/ai/chat/chatRegistration';
import { makeHarness } from '../harness';
import { makeToken } from './chatHarness';

const root = join(__dirname, '..', '..', '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
  string,
  any
>;

describe('manifest contract for @filemaker', () => {
  const participants = manifest.contributes.chatParticipants as Array<Record<string, any>>;

  it('declares one participant whose id, name and commands match the code', () => {
    expect(participants).toHaveLength(1);
    const participant = participants[0] as Record<string, any>;
    expect(participant.id).toBe(CHAT_PARTICIPANT_ID);
    expect(participant.name).toBe('filemaker');
    expect(
      (participant.commands as Array<{ name: string; description: string }>).map(
        (command) => command.name
      )
    ).toEqual([...CHAT_COMMANDS]);
    for (const command of participant.commands as Array<{ name: string; description: string }>) {
      expect(command.description.length, command.name).toBeGreaterThan(5);
    }
  });

  it('activates on the participant (the extension also activates at start-up)', () => {
    expect(manifest.activationEvents).toContain(`onChatParticipant:${CHAT_PARTICIPANT_ID}`);
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });

  it('keeps the editor floor and uses no proposed API', () => {
    expect(manifest.engines.vscode).toBe('^1.96.0');
    expect(manifest.devDependencies['@types/vscode']).toMatch(/1\.96/);
    expect(manifest.enabledApiProposals).toBeUndefined();
  });

  it('contributes no write or script capability for chat: no command and no tool is added', () => {
    const commandIds = (manifest.contributes.commands as Array<{ command: string }>).map(
      (command) => command.command
    );
    expect(commandIds.filter((id) => /chat/i.test(id))).toEqual([]);
    expect(
      CHAT_COMMANDS.filter((name) => /edit|create|delete|write|script|run/i.test(name))
    ).toEqual([]);
  });
});

describe('registration', () => {
  it('feature-detects the chat API', () => {
    expect(getChatApi()).toBeUndefined();
    expect(registerChatParticipant({ service: makeHarness().service })).toBeUndefined();
  });

  it('registers the declared id and passes a plain-string stream through to the handler', async () => {
    const h = makeHarness({ settings: { enabled: false } });
    let handler: any;
    const dispose = vi.fn();
    const createChatParticipant = vi.fn((id: string, fn: unknown) => {
      handler = fn;
      return { dispose };
    });
    const registered = registerChatParticipant({
      service: h.service,
      chat: { createChatParticipant } as any
    });
    expect(createChatParticipant).toHaveBeenCalledWith(CHAT_PARTICIPANT_ID, expect.any(Function));
    expect(registered).toBeDefined();

    const markdown = vi.fn();
    const button = vi.fn();
    const { token } = makeToken();
    const result = await handler(
      { command: 'layouts', prompt: '', model: undefined },
      {},
      { markdown, button, progress: vi.fn() },
      token
    );
    expect(result.metadata).toEqual({ command: 'layouts', outcome: 'off' });
    expect(markdown.mock.calls[0]?.[0]).toEqual(expect.stringContaining('AI tools are off'));
    expect(typeof markdown.mock.calls[0]?.[0]).toBe('string');
    expect(button).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'workbench.action.openGlobalSettings' })
    );
    expect(h.client.listLayouts).not.toHaveBeenCalled();
  });

  it('the kill switch and trust turn the registered participant off on the next request', async () => {
    const h = makeHarness();
    let handler: any;
    registerChatParticipant({
      service: h.service,
      chat: {
        createChatParticipant: (_id: string, fn: unknown) => ((handler = fn), { dispose: vi.fn() })
      } as any
    });
    const ask = async () => {
      const markdown = vi.fn();
      await handler(
        { command: 'layouts', prompt: '' },
        {},
        { markdown, button: vi.fn(), progress: vi.fn() },
        makeToken().token
      );
      return String(markdown.mock.calls.at(-1)?.[0]);
    };
    expect(await ask()).toContain('Layouts in the connected database');
    h.service.setKilled(true);
    expect(await ask()).toContain('switched off');
    h.service.setKilled(false);
    h.state.trusted = false;
    expect(await ask()).toContain('untrusted workspace');
  });
});
