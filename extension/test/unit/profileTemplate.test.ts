import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadConnectionProfileTemplate,
  parseConnectionProfileTemplate,
  PROFILE_TEMPLATE_LOCKED_FIELDS
} from '../../src/services/profileTemplate';

describe('parseConnectionProfileTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes allowed non-credential template fields', () => {
    const result = parseConnectionProfileTemplate(
      JSON.stringify({
        name: ' Team Dev ',
        authMode: 'direct',
        serverUrl: ' https://fm-dev.example.com/ ',
        database: ' TeamApp ',
        apiBasePath: ' /fmi/data ',
        apiVersionPath: ' vLatest ',
        username: ' developer ',
        locked: true
      })
    );

    expect(result.warning).toBeUndefined();
    expect(result.template).toMatchObject({
      name: 'Team Dev',
      authMode: 'direct',
      serverUrl: 'https://fm-dev.example.com',
      database: 'TeamApp',
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest',
      username: 'developer',
      locked: true
    });
  });

  it('rejects credential-bearing templates without echoing secret values', () => {
    const result = parseConnectionProfileTemplate(
      JSON.stringify({
        serverUrl: 'https://fm-dev.example.com',
        database: 'TeamApp',
        password: 'super-secret'
      })
    );

    expect(result.template).toBeUndefined();
    expect(result.warning).toContain('credential fields');
    expect(result.warning).not.toContain('super-secret');
  });

  it('rejects case-variant credential fields with a credential warning', () => {
    const result = parseConnectionProfileTemplate(
      JSON.stringify({
        serverUrl: 'https://fm-dev.example.com',
        database: 'TeamApp',
        ProxyApiKey: 'super-secret'
      })
    );

    expect(result.template).toBeUndefined();
    expect(result.warning).toContain('credential fields');
    expect(result.warning).not.toContain('super-secret');
  });

  it('rejects non-string field values instead of silently dropping them', () => {
    const result = parseConnectionProfileTemplate(
      JSON.stringify({
        serverUrl: 123,
        database: 'TeamApp'
      })
    );

    expect(result.template).toBeUndefined();
    expect(result.warning).toContain('invalid serverUrl');
  });

  it('rejects empty templates instead of showing an empty prefill banner', () => {
    const result = parseConnectionProfileTemplate(JSON.stringify({ locked: false }));

    expect(result.template).toBeUndefined();
    expect(result.warning).toContain('does not include any profile fields');
  });

  it('rejects invalid server URLs as a non-fatal warning', () => {
    const result = parseConnectionProfileTemplate(
      JSON.stringify({
        serverUrl: 'not-a-url',
        database: 'TeamApp'
      })
    );

    expect(result.template).toBeUndefined();
    expect(result.warning).toContain('invalid serverUrl');
  });

  it('treats a missing workspace template as no template', async () => {
    const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockRejectedValue({ code: 'FileNotFound' });

    await expect(loadConnectionProfileTemplate()).resolves.toEqual({});
  });

  it('ignores a template in an untrusted workspace', async () => {
    const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFile.mockResolvedValue(Buffer.from(JSON.stringify({ serverUrl: 'https://attacker.example', database: 'Sales' })));
    const workspace = vscode.workspace as unknown as { isTrusted: boolean };
    workspace.isTrusted = false;
    try {
      const result = await loadConnectionProfileTemplate();
      expect(result.template).toBeUndefined();
      expect(result.warning).toMatch(/not trusted/);
    } finally {
      workspace.isTrusted = true;
    }
  });

  it('never locks the server address', () => {
    expect(PROFILE_TEMPLATE_LOCKED_FIELDS).not.toContain('serverUrl');
    expect(PROFILE_TEMPLATE_LOCKED_FIELDS).not.toContain('proxyEndpoint');
  });

  it('rejects a template with credentials in a URL or an invalid proxyEndpoint', () => {
    expect(parseConnectionProfileTemplate(JSON.stringify({ serverUrl: 'https://admin:pw@fm.example.com' })).warning).toContain('invalid serverUrl');
    expect(parseConnectionProfileTemplate(JSON.stringify({ authMode: 'proxy', proxyEndpoint: 'ftp://x' })).warning).toContain('invalid proxyEndpoint');
    expect(parseConnectionProfileTemplate(JSON.stringify({ authMode: 'proxy', proxyEndpoint: 'https://proxy.example.com/api' })).template?.proxyEndpoint).toBe('https://proxy.example.com/api');
  });
});
