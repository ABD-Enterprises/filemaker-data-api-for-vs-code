import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_TOOL_DEFINITIONS } from '../../../../src/ai/aiToolDefinitions';
import { AiMcpServer, type McpToolCore } from '../../../../src/ai/mcp/aiMcpServer';
import { newToken } from '../../../../src/ai/mcp/auth';
import { isExpectedSocketPath } from '../../../../src/ai/mcp/discovery';
import { createEndpoint } from '../../../../src/ai/mcp/socketPath';
import { RawClient } from './mcpClientHelper';

// The Windows transport is a named pipe whose name is the only thing a local process has to
// guess, and the token in the hello message is the only access control (Node cannot set an ACL on
// a pipe). These tests run on a real Windows host in CI: a real pipe, a real server, real clients.
// They are skipped elsewhere because a pipe name is meaningless on Unix, where the other MCP test
// files cover the Unix socket (0600 socket in a 0700 folder).
describe.skipIf(process.platform !== 'win32')('MCP server on a Windows named pipe', () => {
  let base: string;
  let token: string;
  const servers: AiMcpServer[] = [];
  const clients: RawClient[] = [];
  const core = { listTools: () => AI_TOOL_DEFINITIONS.filter((tool) => tool.kind === 'read'), invoke: vi.fn(async () => ({ ok: true })) } as unknown as McpToolCore;

  async function startServer(): Promise<string> {
    // No platform option: on Windows the endpoint must come out as a pipe by default.
    const endpoint = await createEndpoint({ baseDirectory: base });
    expect(endpoint.isPipe).toBe(true);
    const server = new AiMcpServer({ core, token, endpoint: endpoint.path, serverInfo: { name: 'pipe', version: '1' } });
    await server.start();
    servers.push(server);
    return endpoint.path;
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'fm-pipe-'));
    token = newToken();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.stop();
    await rm(base, { recursive: true, force: true });
  });

  it('listens on a pipe the discovery check accepts, and creates no socket folder', async () => {
    const path = await startServer();
    expect(path).toMatch(/^\\\\\.\\pipe\\fm-ai-[0-9a-f]{32}$/);
    expect(isExpectedSocketPath(path)).toBe(true);
  });

  it('answers the hello with the right token and then serves a request', async () => {
    const path = await startServer();
    const client = await RawClient.connect(path);
    clients.push(client);
    expect(await client.hello(token)).toBe('{"hello":"ok"}');
    client.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(await client.next()).toContain('"result"');
  });

  it('closes a connection that sends the wrong token, or a request before the hello, without a reply', async () => {
    const path = await startServer();
    const wrong = await RawClient.connect(path);
    clients.push(wrong);
    expect(await wrong.hello(newToken())).toBe('<closed>');

    const eager = await RawClient.connect(path);
    clients.push(eager);
    eager.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    expect(await eager.next()).toBe('<closed>');
  });

  it('gives every server its own unguessable pipe, and a guessed name finds nothing', async () => {
    const first = await startServer();
    const second = await startServer();
    expect(second).not.toBe(first);

    // A process that has not read the discovery file has to guess 128 bits; any other name is simply absent.
    await expect(RawClient.connect(`${first.slice(0, -4)}0000`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(RawClient.connect('\\\\.\\pipe\\fm-ai-guess')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the pipe when the server stops, so nothing is left to connect to', async () => {
    const path = await startServer();
    const server = servers.pop() as AiMcpServer;
    await server.stop();
    await expect(RawClient.connect(path)).rejects.toThrow();
  });

  it('keeps serving a second client while the first is connected', async () => {
    const path = await startServer();
    const a = await RawClient.connect(path);
    const b = await RawClient.connect(path);
    clients.push(a, b);
    expect(await a.hello(token)).toBe('{"hello":"ok"}');
    expect(await b.hello(token)).toBe('{"hello":"ok"}');
  });
});
