// Reference implementation of the extension's "proxy" auth mode: one POST endpoint that receives
// { action, profile, payload } and answers { ok, data } (see src/services/proxyClient.ts). It logs
// in to the mock as `tester`, keeps one session per profile id, and renews it once on expiry.
import { PROXY_API_KEY } from './engine.mjs';

export const PROXY_PATH = '/__proxy';
const basic = `Basic ${Buffer.from('tester:testpass1').toString('base64')}`;

export async function handleProxy(engine, input) {
  if (
    input.headers.authorization !== `Bearer ${PROXY_API_KEY}` &&
    process.env.PROXY_REQUIRE_KEY !== '0'
  ) {
    return { status: 401, json: { ok: false, error: 'Invalid proxy API key' } };
  }
  let req;
  try {
    req = JSON.parse(input.body.toString('utf8'));
  } catch {
    return { status: 400, json: { ok: false, error: 'Malformed JSON' } };
  }
  const { action, profile, payload = {} } = req;
  const db = encodeURIComponent(profile?.database ?? '');
  const root = `/fmi/data/${profile?.apiVersionPath ?? 'vLatest'}/databases/${db}`;
  engine.proxySessions ??= new Map();

  const call = async (method, path, { body, headers = {}, query = '' } = {}, token) =>
    engine.dispatch({
      method,
      pathname: path,
      query: new URLSearchParams(query),
      protocol: input.protocol,
      headers: {
        host: input.headers.host,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
        ...(body && !headers['content-type'] ? { 'content-type': 'application/json' } : {})
      },
      body: body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : undefined
    });
  const login = async () => {
    const r = await call('POST', `${root}/sessions`, {
      body: {},
      headers: { authorization: basic }
    });
    if (r.status !== 200) return { fail: r };
    engine.proxySessions.set(profile.id, r.json.response.token);
    return { token: r.json.response.token };
  };
  const authed = async (method, path, opts) => {
    let token = engine.proxySessions.get(profile.id);
    if (!token) {
      const l = await login();
      if (l.fail) return l.fail;
      token = l.token;
    }
    let r = await call(method, path, opts, token);
    if (r.status === 401 && r.json?.messages?.[0]?.code === '952') {
      const l = await login();
      if (l.fail) return l.fail;
      r = await call(method, path, opts, l.token);
    }
    return r;
  };
  const fail = (r) => ({
    status: r.status,
    json: { ok: false, error: r.json?.messages?.[0]?.message ?? 'Upstream error', details: r.json }
  });
  const done = (r, data) =>
    r.status === 200 ? { status: 200, json: { ok: true, data } } : fail(r);
  const L = (n) => `${root}/layouts/${encodeURIComponent(n)}`;

  switch (action) {
    case 'createSession': {
      const l = await login();
      return l.fail ? fail(l.fail) : { status: 200, json: { ok: true, data: { token: l.token } } };
    }
    case 'deleteSession': {
      const t = engine.proxySessions.get(profile.id);
      if (t) await call('DELETE', `${root}/sessions/${t}`, {}, t);
      engine.proxySessions.delete(profile.id);
      return { status: 200, json: { ok: true, data: {} } };
    }
    case 'listLayouts': {
      const r = await authed('GET', `${root}/layouts`);
      return done(r, { layouts: r.json?.response?.layouts });
    }
    case 'listScripts': {
      const r = await authed('GET', `${root}/scripts`);
      return done(r, { scripts: r.json?.response?.scripts });
    }
    case 'getRecord': {
      const r = await authed(
        'GET',
        `${L(payload.layout)}/records/${encodeURIComponent(payload.recordId)}`
      );
      return done(r, { record: r.json?.response?.data?.[0] });
    }
    case 'findRecords': {
      const r = await authed('POST', `${L(payload.layout)}/_find`, { body: payload.body });
      return done(r, { result: r.json?.response });
    }
    case 'getLayoutMetadata': {
      const r = await authed('GET', L(payload.layout));
      return done(r, r.json?.response);
    }
    case 'runScript': {
      const q = new URLSearchParams();
      if (payload.scriptParam !== undefined) q.set('script.param', payload.scriptParam);
      const r = await authed(
        'GET',
        `${L(payload.layout)}/script/${encodeURIComponent(payload.scriptName)}`,
        { query: q.toString() }
      );
      return done(r, { result: { response: r.json?.response, messages: r.json?.messages } });
    }
    case 'editRecord': {
      const r = await authed(
        'PATCH',
        `${L(payload.layout)}/records/${encodeURIComponent(payload.recordId)}`,
        {
          body: {
            fieldData: payload.fieldData,
            ...(payload.modId !== undefined ? { modId: payload.modId } : {})
          }
        }
      );
      return done(r, {
        result: {
          recordId: payload.recordId,
          modId: r.json?.response?.modId,
          messages: r.json?.messages,
          response: r.json?.response
        }
      });
    }
    case 'createRecord': {
      const r = await authed('POST', `${L(payload.layout)}/records`, {
        body: { fieldData: payload.fieldData }
      });
      return done(r, {
        result: {
          recordId: r.json?.response?.recordId,
          modId: r.json?.response?.modId,
          messages: r.json?.messages,
          response: r.json?.response
        }
      });
    }
    case 'deleteRecord': {
      const r = await authed(
        'DELETE',
        `${L(payload.layout)}/records/${encodeURIComponent(payload.recordId)}`
      );
      return done(r, {
        result: {
          recordId: payload.recordId,
          messages: r.json?.messages,
          response: r.json?.response
        }
      });
    }
    case 'uploadContainer': {
      const boundary = '----mockproxy';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="${payload.fileName}"\r\nContent-Type: ${payload.contentType}\r\n\r\n`
        ),
        Buffer.from(payload.contentBase64, 'base64'),
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);
      const q = payload.modId !== undefined ? `modId=${payload.modId}` : '';
      const r = await authed(
        'POST',
        `${L(payload.layout)}/records/${encodeURIComponent(payload.recordId)}/containers/${encodeURIComponent(payload.fieldName)}/${payload.fieldRepetition ?? 1}`,
        { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, query: q }
      );
      return done(r, {
        result: {
          recordId: payload.recordId,
          messages: r.json?.messages,
          response: r.json?.response
        }
      });
    }
    default:
      return { status: 400, json: { ok: false, error: `Unknown action ${action}` } };
  }
}
