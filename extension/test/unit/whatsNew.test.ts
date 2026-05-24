import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  WHATS_NEW_LAST_SEEN_VERSION_KEY,
  compareExtensionVersions,
  maybeOpenWhatsNewAfterUpgrade,
  registerWalkthroughCommands
} from '../../src/extension';
import { InMemoryMemento } from './mocks';

const FIRST_RUN_FLAG = 'filemaker.walkthrough.shownOnce';

function createContext(version: string) {
  const globalState = new InMemoryMemento();
  const context = {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: { fsPath: '/test/extension', toString: () => 'file:///test/extension' },
    globalState,
    extension: {
      id: 'deffenda.filemaker-data-api-tools',
      packageJSON: { version }
    }
  } as unknown as vscode.ExtensionContext & { globalState: InMemoryMemento };

  return { context, globalState };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn()
  };
}

describe('compareExtensionVersions', () => {
  it('orders semantic versions by major, minor, and patch', () => {
    expect(compareExtensionVersions('1.2.0', '1.1.9')).toBe(1);
    expect(compareExtensionVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareExtensionVersions('1.2.0-beta.1', '1.2.0')).toBe(-1);
  });
});

describe('maybeOpenWhatsNewAfterUpgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records the current version without opening on fresh install', async () => {
    const { context, globalState } = createContext('1.2.0');

    await maybeOpenWhatsNewAfterUpgrade(context, createLogger());

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(globalState.get(WHATS_NEW_LAST_SEEN_VERSION_KEY)).toBe('1.2.0');
  });

  it('opens the matching release walkthrough once after an upgrade', async () => {
    const { context, globalState } = createContext('1.2.0');
    await globalState.update(FIRST_RUN_FLAG, true);

    await maybeOpenWhatsNewAfterUpgrade(context, createLogger());

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openWalkthrough',
      'deffenda.filemaker-data-api-tools#filemakerWhatsNew120',
      false
    );
    expect(globalState.get(WHATS_NEW_LAST_SEEN_VERSION_KEY)).toBe('1.2.0');
  });

  it('does not reopen when the current version was already seen', async () => {
    const { context, globalState } = createContext('1.2.0');
    await globalState.update(FIRST_RUN_FLAG, true);
    await globalState.update(WHATS_NEW_LAST_SEEN_VERSION_KEY, '1.2.0');

    await maybeOpenWhatsNewAfterUpgrade(context, createLogger());

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});

describe('registerWalkthroughCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers a manual Show What's New command that opens the current walkthrough", async () => {
    const { context } = createContext('1.2.0');
    const logger = createLogger();

    registerWalkthroughCommands(context, logger);

    const registration = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(([command]) => command === 'filemakerDataApiTools.showWhatsNew');
    expect(registration).toBeDefined();

    const handler = registration?.[1] as () => Promise<void>;
    await handler();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openWalkthrough',
      'deffenda.filemaker-data-api-tools#filemakerWhatsNew120',
      false
    );
  });
});
