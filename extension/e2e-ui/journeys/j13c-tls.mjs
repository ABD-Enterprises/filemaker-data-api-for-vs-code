// Journey 13c: TLS failure modes through the connection wizard (docs/FILEMAKER_FAILURE_MODES.md section 1).
// Test Connection against the mock in each TLS mode, with and without the Certificates (advanced) options, and
// then Connect from a saved profile to see the toast and its buttons.
import fs from 'node:fs';
import path from 'node:path';

import { startMock } from '../lib/mock.mjs';
import { connectAction, observe, summarise } from '../lib/observe.mjs';
import { createProfile, describeTest, ensureProfileCommands, wizardTest } from '../lib/flows.mjs';

const J = 'J13c TLS';
const BARE = /^Failed to create FileMaker session\.?\s*$/;

async function probe(s, { url, name = 'tls-probe', ca = '', answer }) {
  await s.closeAllEditors();
  await s.cmd('FileMaker: Add Connection Profile');
  const wv = await s.webview('#wizardForm');
  for (const [id, v] of Object.entries({
    profileName: name,
    serverUrl: url,
    database: 'Quality',
    username: 'tester',
    password: 'testpass1'
  }))
    await wv.locator(`#${id}`).fill(v);
  if (ca) {
    await wv.locator('#certificateOptions summary').click();
    await wv.locator('#caBundlePath').fill(ca);
  }
  const t = await wizardTest(s, wv, { answer });
  return {
    st: `${t.status} ${t.modal ? `[modal: ${t.modal.text.replace(/\s+/g, ' ').slice(0, 600)}]` : ''}`.trim(),
    t,
    wv
  };
}

export async function run(ctx) {
  const { s, mock } = ctx;
  if (!ctx.profileMain) {
    await createProfile(s, { name: 'Mock Quality', url: mock.baseUrl, database: 'Quality' });
    ctx.profileMain = true;
  }
  await ensureProfileCommands(s);
  await s.setSetting('filemaker.requestTimeoutMs', 5000);
  const mocks = {};
  const modes = [
    'expired',
    'notyet',
    'wronghost',
    'missing-intermediate',
    'tls10-only',
    'self-signed',
    'ca'
  ];
  for (const m of modes) {
    mocks[m] = await startMock({ TLS: m });
    (ctx.cleanups ??= []).push(() => mocks[m].stop());
  }

  const row = (name, expectText, fn) => s.step(J, name, expectText, fn);
  const judge = (st, mustMention, gapMsg) => {
    if (BARE.test(st) || !mustMention.test(st)) throw new Error(`${gapMsg} :: shown: "${st}"`);
    return `shown: "${st}"`;
  };

  // 1.1 - 1.5: the CA is trusted (CA file set) so the specific certificate problem is what remains.
  await row(
    '1.1 expired certificate (CA file trusted)',
    'says the certificate expired (code CERT_HAS_EXPIRED), no Retry',
    async () => {
      const { st } = await probe(s, { url: mocks.expired.baseUrl, ca: mocks.expired.caPath });
      return judge(
        st,
        /expired/i,
        'the wizard does not say the certificate expired (confirms 1.1/B1)'
      );
    }
  );
  await row(
    '1.2 certificate not yet valid',
    'says not yet valid / check the computer clock',
    async () => {
      const { st } = await probe(s, { url: mocks.notyet.baseUrl, ca: mocks.notyet.caPath });
      return judge(
        st,
        /not yet valid|clock|date/i,
        'no mention of not-yet-valid or the clock (confirms 1.2/B1)'
      );
    }
  );
  await row(
    '1.5 hostname mismatch',
    'names the certificate host vs the connected host',
    async () => {
      const { st } = await probe(s, { url: mocks.wronghost.baseUrl, ca: mocks.wronghost.caPath });
      return judge(
        st,
        /host|name|altnames|match/i,
        'no mention of a hostname mismatch (confirms 1.5/B1)'
      );
    }
  );
  await row(
    '1.3 self-signed server, no option',
    'points at Certificates (advanced) / CA file',
    async () => {
      const { st } = await probe(s, { url: mocks['self-signed'].baseUrl });
      return judge(
        st,
        /Certificates \(advanced\)|CA certificate file|trusted authority|does not trust/i,
        'the message shows only Node text, no pointer to the CA option (confirms 1.3 message gap)'
      );
    }
  );
  await row(
    '1.4 private CA not trusted (no CA file)',
    'says this computer does not trust the issuing authority',
    async () => {
      const { st } = await probe(s, { url: mocks.ca.baseUrl });
      return judge(
        st,
        /does not trust|not trusted by|Certificates \(advanced\)|CA certificate file|trusted authority/i,
        'Node wording only: "unable to verify the first certificate" (confirms 1.4)'
      );
    }
  );
  await row(
    '1.7 missing intermediate (CA file = root only)',
    'explains an incomplete chain / install the intermediate',
    async () => {
      const { st } = await probe(s, {
        url: mocks['missing-intermediate'].baseUrl,
        ca: mocks['missing-intermediate'].caPath
      });
      return judge(
        st,
        /intermediate|chain|incomplete/i,
        'same text as 1.4: cannot tell an incomplete chain from an untrusted CA (confirms 1.7)'
      );
    }
  );
  await row(
    '1.7b missing intermediate, CA file = root + intermediate',
    'connects (workaround from the catalogue)',
    async () => {
      const both = path.join(s.ws, 'root-and-intermediate.pem');
      fs.writeFileSync(
        both,
        fs.readFileSync(mocks['missing-intermediate'].caPath, 'utf8') +
          fs.readFileSync(mocks['missing-intermediate'].intermediatePath, 'utf8')
      );
      const { st } = await probe(s, { url: mocks['missing-intermediate'].baseUrl, ca: both });
      if (!/uccess|onnect/i.test(st)) throw new Error(`did not connect: ${st}`);
      return st;
    }
  );
  await row(
    '1.11 server offers only TLS 1.0/1.1',
    'says the server only supports old TLS versions',
    async () => {
      const { st } = await probe(s, {
        url: mocks['tls10-only'].baseUrl,
        ca: mocks['tls10-only'].caPath
      });
      return judge(st, /TLS|protocol|version|old/i, 'bare text only (confirms 1.11)');
    }
  );
  await row(
    '1.13 http:// profile pointed at the TLS port',
    'says the server did not answer plain http / try https',
    async () => {
      const { st } = await probe(s, { url: mocks.ca.baseUrl.replace('https://', 'http://') });
      return judge(st, /https|plain http|TLS/i, 'bare text only (confirms 1.13)');
    }
  );
  await row(
    '1.14 https:// profile pointed at a plain-HTTP port',
    'says that port does not speak https',
    async () => {
      const { st } = await probe(s, { url: mock.baseUrl.replace('http://', 'https://') });
      return judge(st, /https|port|TLS|protocol/i, 'bare text only (confirms 1.14)');
    }
  );
  await row('1.15 nothing listening on the port', 'names host:port', async () => {
    const { st } = await probe(s, { url: 'http://127.0.0.1:1' });
    return judge(st, /127\.0\.0\.1|port|refused|listening/i, 'bare text only (confirms 1.15)');
  });
  await row('1.16 DNS failure', 'names the host that could not be found', async () => {
    const { st } = await probe(s, { url: 'https://no-such-host.invalid' });
    return judge(st, /no-such-host|name|DNS|found/i, 'bare text only (confirms 1.16)');
  });

  await s.setSetting('filemaker.requestTimeoutMs', undefined);
}
