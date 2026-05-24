import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

import { registerRecordEditCommands } from '../../../src/commands/recordEdit';
import type { ConnectionProfile } from '../../../src/types/fm';

function profile(): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Dev',
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB'
  };
}

function createDeps() {
  const uploadContainer = vi.fn().mockResolvedValue({
    recordId: '42',
    messages: [{ code: '0', message: 'OK' }],
    response: {}
  });

  return {
    context: {
      subscriptions: [],
      extensionUri: { fsPath: '/ext' }
    } as unknown as vscode.ExtensionContext,
    profileStore: {
      getProfile: vi.fn().mockResolvedValue(profile()),
      listProfiles: vi.fn().mockResolvedValue([profile()]),
      getActiveProfileId: vi.fn().mockReturnValue('profile-1')
    } as never,
    fmClient: {
      listLayouts: vi.fn().mockResolvedValue(['Contacts']),
      uploadContainer
    } as never,
    schemaService: {} as never,
    settingsService: {
      isRecordEditEnabled: vi.fn().mockReturnValue(true),
      getContainerUploadMaxBytes: vi.fn().mockReturnValue(4)
    } as never,
    roleGuard: {
      assertFeature: vi.fn().mockResolvedValue(true)
    } as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never,
    uploadContainer
  };
}

describe('Upload to Container command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const fsMock = vscode.workspace.fs as unknown as {
      stat: ReturnType<typeof vi.fn>;
      readFile: ReturnType<typeof vi.fn>;
    };
    fsMock.stat = vi.fn().mockResolvedValue({ size: 4 });
    fsMock.readFile.mockResolvedValue(Buffer.from('data'));
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([
      {
        fsPath: '/tmp/report.pdf',
        path: '/tmp/report.pdf'
      } as vscode.Uri
    ]);
  });

  it('reads the selected file and passes the configured max bytes to FMClient', async () => {
    const deps = createDeps();
    registerRecordEditCommands(deps);

    const uploadCommand = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(([name]) => name === 'filemakerDataApiTools.uploadContainer')?.[1] as (
      arg: unknown
    ) => Promise<boolean>;

    await expect(
      uploadCommand({
        profileId: 'profile-1',
        layout: 'Contacts',
        recordId: '42',
        fieldName: 'Attachment'
      })
    ).resolves.toBe(true);

    expect(deps.uploadContainer).toHaveBeenCalledWith(
      profile(),
      'Contacts',
      '42',
      'Attachment',
      {
        fileName: 'report.pdf',
        content: Buffer.from('data'),
        contentType: 'application/pdf'
      },
      {
        fieldRepetition: undefined,
        modId: undefined,
        maxBytes: 4
      }
    );
  });
});
