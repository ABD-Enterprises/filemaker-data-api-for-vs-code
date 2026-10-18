/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { AI_TOOL_NAMES, AiToolsController, computeAiStatus, getLanguageModelApi } from '../../../src/ai/aiRegistration';
import { AI_TOOL_DEFINITIONS } from '../../../src/ai/aiToolDefinitions';
import { makeHarness } from './harness';

function lmFake() {
  const registered = new Map<string, { tool: vscode.LanguageModelTool<object>; dispose: ReturnType<typeof vi.fn> }>();
  return {
    registered,
    api: {
      registerTool: vi.fn((name: string, tool: vscode.LanguageModelTool<object>) => {
        const dispose = vi.fn(() => void registered.delete(name));
        registered.set(name, { tool, dispose });
        return { dispose };
      })
    }
  };
}

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
  contributes: {
    languageModelTools: Array<Record<string, any>>;
    commands: Array<{ command: string }>;
    menus: { commandPalette: Array<{ command: string; when: string }> };
  };
};

describe('manifest contract', () => {
  it('declares exactly the tools the core defines, with the same schemas', () => {
    const declared = manifest.contributes.languageModelTools;
    expect(declared.map((tool) => tool.name).sort()).toEqual([...AI_TOOL_NAMES].sort());
    for (const definition of AI_TOOL_DEFINITIONS) {
      const entry = declared.find((tool) => tool.name === definition.name)!;
      expect(entry.inputSchema, definition.name).toEqual(JSON.parse(JSON.stringify(definition.inputSchema)));
      expect(entry.modelDescription).toBe(definition.modelDescription);
      expect(entry.toolReferenceName).toBe(definition.toolReferenceName);
      expect(entry.canBeReferencedInPrompt).toBe(true);
      expect(entry.inputSchema.additionalProperties, definition.name).toBe(false);
    }
  });

  it('gates every tool with a when clause, and write and script tools with their own context keys', () => {
    for (const entry of manifest.contributes.languageModelTools) {
      expect(entry.when, entry.name).toContain('filemaker.ai.active');
    }
    const byName = (name: string) => manifest.contributes.languageModelTools.find((tool) => tool.name === name)!;
    expect(byName('fm_edit_record').when).toContain('filemaker.ai.writes');
    expect(byName('fm_delete_record').when).toContain('filemaker.ai.writes');
    expect(byName('fm_run_script').when).toContain('filemaker.ai.scripts');
    expect(byName('fm_find_records').when).toBe('filemaker.ai.active');
  });

  it('contributes the three AI commands with palette conditions', () => {
    const ids = new Set(manifest.contributes.commands.map((command) => command.command));
    for (const id of ['setAiAccess', 'toggleAiKillSwitch', 'showAiActivity']) {
      expect(ids.has(`filemakerDataApiTools.${id}`), id).toBe(true);
      expect(manifest.contributes.menus.commandPalette.find((entry) => entry.command === `filemakerDataApiTools.${id}`)?.when).toBeTruthy();
    }
  });
});

describe('AiToolsController', () => {
  it('registers read tools only until writes and scripts are switched on, then adds them', () => {
    const h = makeHarness({ settings: { allowWrites: false, allowScripts: false } });
    const lm = lmFake();
    const setContext = vi.fn();
    const controller = new AiToolsController(h.service, { lm: lm.api, setContext });
    controller.refresh();
    expect(controller.registeredNames()).toEqual(
      AI_TOOL_DEFINITIONS.filter((tool) => tool.kind === 'read').map((tool) => tool.name).sort()
    );
    expect(setContext).toHaveBeenCalledWith('filemaker.ai.writes', false);

    h.settings.allowWrites = true;
    h.settings.allowScripts = true;
    controller.refresh();
    expect(controller.registeredNames()).toEqual([...AI_TOOL_NAMES].sort());
    expect(setContext).toHaveBeenLastCalledWith('filemaker.ai.scripts', true);
  });

  it('registers nothing in an untrusted workspace, registers on trust, and unregisters when trust is gone or the kill switch is on', () => {
    const h = makeHarness();
    h.state.trusted = false;
    const lm = lmFake();
    const controller = new AiToolsController(h.service, { lm: lm.api });
    controller.refresh();
    expect(lm.api.registerTool).not.toHaveBeenCalled();

    h.state.trusted = true; // onDidGrantWorkspaceTrust
    controller.refresh();
    expect(controller.registeredNames().length).toBe(AI_TOOL_NAMES.length);

    h.state.trusted = false; // revoked
    controller.refresh();
    expect(controller.registeredNames()).toEqual([]);

    h.state.trusted = true;
    controller.refresh();
    h.service.setKilled(true);
    controller.refresh();
    expect(controller.registeredNames()).toEqual([]);
    expect(lm.registered.size).toBe(0);
  });

  it('does not register twice and disposes everything', () => {
    const h = makeHarness();
    const lm = lmFake();
    const controller = new AiToolsController(h.service, { lm: lm.api });
    controller.refresh();
    controller.refresh();
    expect(lm.api.registerTool).toHaveBeenCalledTimes(AI_TOOL_NAMES.length);
    controller.dispose();
    expect(lm.registered.size).toBe(0);
  });

  it('is a no-op when the editor has no language model API', () => {
    const h = makeHarness();
    const controller = new AiToolsController(h.service, { lm: undefined });
    expect(() => controller.refresh()).not.toThrow();
    expect(controller.registeredNames()).toEqual([]);
    expect(getLanguageModelApi()).toBeUndefined();
  });

  it('passes input to the core and returns the result as one text part of JSON', async () => {
    const h = makeHarness();
    const lm = lmFake();
    new AiToolsController(h.service, { lm: lm.api }).refresh();
    const tool = lm.registered.get('fm_explain_error')!.tool;
    const token = { isCancellationRequested: false, onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })) };
    const result = (await tool.invoke({ input: { code: 306 } } as never, token as never)) as unknown as { content: Array<{ value: string }> };
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.value)).toMatchObject({ code: 306, known: true });
  });

  it('applies policy inside invoke even if the tool was registered earlier (a stale registration cannot bypass it)', async () => {
    const h = makeHarness();
    const lm = lmFake();
    new AiToolsController(h.service, { lm: lm.api }).refresh();
    const tool = lm.registered.get('fm_list_layouts')!.tool;
    h.settings.enabled = false; // changed after registration, before refresh
    await expect(tool.invoke({ input: {} } as never, { onCancellationRequested: () => ({ dispose() {} }) } as never)).rejects.toThrow(/AI tools are off/);
  });

  it('write tools ask in invoke and do not rely on prepareInvocation confirmation', async () => {
    const h = makeHarness();
    h.settings.readableLayouts = { p1: ['Contacts'] };
    const lm = lmFake();
    new AiToolsController(h.service, { lm: lm.api }).refresh();
    for (const name of ['fm_edit_record', 'fm_create_record', 'fm_delete_record', 'fm_run_script']) {
      const prepared = await lm.registered.get(name)!.tool.prepareInvocation!({ input: {} } as never, {} as never);
      expect(prepared, name).not.toHaveProperty('confirmationMessages');
    }
    const edit = lm.registered.get('fm_edit_record')!.tool;
    await edit.invoke({ input: { layout: 'Contacts', recordId: '1', fields: { Name: 'Z' } } } as never, { onCancellationRequested: () => ({ dispose() {} }) } as never);
    expect(h.confirms.some((spec) => spec.title.includes('change a record'))).toBe(true);
  });

  it('turns a cancelled token into a cancelled call', async () => {
    const h = makeHarness();
    const lm = lmFake();
    new AiToolsController(h.service, { lm: lm.api }).refresh();
    let cancel: () => void = () => undefined;
    const token = { onCancellationRequested: (listener: () => void) => ((cancel = listener), { dispose() {} }) };
    h.client.listLayouts.mockImplementation(async (_p: unknown, control?: { signal?: AbortSignal }) => {
      cancel();
      control?.signal?.throwIfAborted();
      return [];
    });
    await expect(lm.registered.get('fm_list_layouts')!.tool.invoke({ input: {} } as never, token as never)).rejects.toThrow(/cancelled/);
  });
});

describe('computeAiStatus', () => {
  const state = { killed: false, recordsUsed: 3, recordQuota: 500, writesUsed: 1, writeCap: 10 };
  const tools = (kinds: Array<'read' | 'write' | 'script'>) => AI_TOOL_DEFINITIONS.filter((tool) => kinds.includes(tool.kind));

  it('shows off, read-only, writes on and scripts on', () => {
    expect(computeAiStatus([], { enabled: false }, state, undefined, 'write').text).toBe('$(circle-slash) AI: off');
    expect(computeAiStatus(tools(['read']), { enabled: true }, state, 'svc', 'write').text).toBe('$(sparkle) AI: read-only');
    expect(computeAiStatus(tools(['read', 'write']), { enabled: true }, state, 'svc', 'write').text).toBe('$(sparkle) AI: writes on');
    expect(computeAiStatus(tools(['read', 'write', 'script']), { enabled: true }, state, 'svc', 'write').text).toBe('$(sparkle) AI: scripts on');
    expect(computeAiStatus(tools(['read']), { enabled: true }, { ...state, killed: true }, 'svc', 'write').text).toBe('$(circle-slash) AI: off');
  });

  it('shows the counters and the FileMaker account, with the account cleaned', () => {
    const { tooltip } = computeAiStatus(tools(['read']), { enabled: true }, state, 'svc\nacct', 'read');
    expect(tooltip).toContain('Records read this session: 3 of 500');
    expect(tooltip).toContain('Write attempts this session: 1 of 10');
    expect(tooltip).toContain('FileMaker account used: svc acct');
  });
});

describe('vscode mock sanity', () => {
  it('has the result classes the transport builds', () => {
    expect(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('x')])).toBeDefined();
  });
});
