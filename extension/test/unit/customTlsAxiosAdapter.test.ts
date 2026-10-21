import type http from 'http';
import type https from 'https';
import { Readable } from 'stream';
import { gzipSync } from 'zlib';

import axios from 'axios';
import nock from 'nock';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { httpsTransportFor } from '../../src/services/tlsAgent';

type DispatchAgent = https.Agent & { addRequest(req: http.ClientRequest, opts: http.RequestOptions): void };
const pending: http.ClientRequest[] = [];
beforeEach(() => nock.restore());
afterEach(() => { pending.splice(0).forEach((req) => req.destroy()); vi.restoreAllMocks(); nock.activate(); });

function response(body: Buffer, status = 200, headers: Record<string, string> = {}) {
  const config = httpsTransportFor({ allowSelfSigned: true }, 'https://fm.example.test');
  vi.spyOn(config.httpsAgent as DispatchAgent, 'addRequest').mockImplementation((req) => {
    pending.push(req);
    // There is no socket in this adapter fixture; supply the error event a real socket supplies.
    const destroy = req.destroy.bind(req);
    req.destroy = (error) => {
      const result = destroy(error);
      if (error) process.nextTick(() => req.emit('error', error));
      return result;
    };
    setImmediate(() => {
      if (req.destroyed) return;
      const res = Object.assign(Readable.from([body]), { statusCode: status, headers, req });
      req.emit('response', res);
    });
  });
  return { ...config, maxRedirects: 0, proxy: false as const };
}

it('keeps axios decompression, response parsing and res.req', async () => {
  const config = response(gzipSync('{"ok":true}'), 200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
  const res = await axios.get('https://fm.example.test', config);
  expect(res.data).toEqual({ ok: true });
  expect(res.request).toBe(pending[0]);
});

it.each(['text', 'stream'] as const)('enforces maxContentLength for a %s response', async (responseType) => {
  const config = response(Buffer.from('too large'));
  const request = axios.get('https://fm.example.test', { ...config, responseType, maxContentLength: 3 });
  if (responseType === 'stream') {
    const res = await request;
    await expect(new Promise((resolve, reject) => { res.data.on('error', reject); res.data.on('end', resolve); res.data.resume(); })).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
  } else {
    await expect(request).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
  }
});

it.each(['buffer', 'stream'] as const)('enforces maxBodyLength for a %s upload', async (kind) => {
  const config = response(Buffer.from('{}'));
  const body = kind === 'stream' ? Readable.from(['too large']) : Buffer.from('too large');
  await expect(axios.post('https://fm.example.test', body, { ...config, maxBodyLength: 3 })).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST' });
});

it('preserves validateStatus and never follows a redirect', async () => {
  const config = response(Buffer.alloc(0), 304);
  expect((await axios.get('https://fm.example.test', { ...config, validateStatus: (status) => status === 304 })).status).toBe(304);
  vi.restoreAllMocks();
  const redirect = response(Buffer.alloc(0), 302, { location: 'https://other.example.test' });
  await expect(axios.get('https://fm.example.test', redirect)).rejects.toMatchObject({ response: { status: 302 } });
  expect(pending).toHaveLength(2);
});
