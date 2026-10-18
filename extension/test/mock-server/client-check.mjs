// End-to-end check of the real FMClient against the mock Data API (see server.mjs).
// Run with `npm run mock:check` from extension/. It starts the mock on a free port, runs the
// checks over real HTTP, stops the mock, and exits non-zero if any check fails.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { extractLayoutFieldNames } from '../../src/utils/layoutFields';
import { InMemorySecretStorage } from '../unit/mocks';

// findForm.js is a classic browser script; load it the way the unit tests do.
const FindForm = createRequire(path.resolve(process.cwd(), 'package.json'))(
  path.resolve(process.cwd(), 'src/webviews/queryBuilder/ui/findForm.js')
);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const logger = { debug() {}, info() {}, warn() {}, error() {} };

let base = '';
const admin = async (route, method = 'GET') => (await fetch(base + route, { method })).json();
const sessionPosts = async () => (await admin('/__admin/log')).sessionPosts;
const errorText = async (action) => {
  try {
    await action();
    return undefined;
  } catch (error) {
    return String(error?.message ?? error);
  }
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startMock() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve(process.cwd(), 'test/mock-server/server.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  base = `http://127.0.0.1:${port}`;
  // Never leave the server behind, however this process ends.
  process.on('exit', () => child.kill());
  process.once('SIGTERM', () => process.exit(143));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await admin('/__admin/reset', 'POST');
      return child;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error('mock server did not start');
}

async function makeClient(password = 'testpass1') {
  const secrets = new SecretStore(new InMemorySecretStorage());
  await secrets.setPassword('p1', password);
  const client = new FMClient(secrets, logger, 5000);
  const profile = {
    id: 'p1',
    name: 'Mock',
    authMode: 'direct',
    serverUrl: base,
    database: 'Sales',
    username: 'tester',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
  return { client, profile };
}

async function runChecks() {
  {
    const { client, profile } = await makeClient('wrong');
    const message = await errorText(() => client.createSession(profile));
    check('wrong password gives a readable error', /password|account|212/i.test(message ?? ''), message);
  }

  const { client, profile } = await makeClient();
  check('login returns a token', (await client.createSession(profile)).length > 20);
  check('lists layouts', JSON.stringify(await client.listLayouts(profile)) === '["Contacts","Invoices"]');
  const fieldNames = extractLayoutFieldNames(await client.getLayoutMetadata(profile, 'Contacts'));
  check('layout fields are extracted', fieldNames.includes('Email'), fieldNames);

  // Paging uses 1-based offsets.
  const open = [{ Status: '==Open' }];
  const page1 = await client.findRecords(profile, 'Contacts', { query: open, limit: 20, offset: 1 });
  const page2 = await client.findRecords(profile, 'Contacts', { query: open, limit: 20, offset: 21 });
  const ids1 = page1.data.map((r) => r.recordId);
  check('page 1 has 20 rows and a found count', page1.data.length === 20 && page1.dataInfo.foundCount > 100, page1.dataInfo);
  check('page 2 follows page 1 with no repeat', page2.data.length === 20 && page2.data.every((r) => !ids1.includes(r.recordId)));
  const tail = await client.findRecords(profile, 'Contacts', { query: open, limit: 20, offset: page1.dataInfo.foundCount - 4 });
  check('the last partial page returns the remaining rows', tail.data.length === 5, tail.data.length);

  // FileMaker reports "no matches" as HTTP 404 + code 401; the client treats it as an empty result.
  const none = await client
    .findRecords(profile, 'Contacts', { query: [{ Email: 'nobody@nowhere.test' }] })
    .then((r) => ({ rows: r.data.length }), (e) => ({ error: String(e.message) }));
  check('a find with no matches returns an empty result', none.rows === 0, none);

  // Conditions produced by the Query Builder form.
  const find = async (criterion) =>
    (
      await client.findRecords(profile, 'Contacts', {
        query: FindForm.modelToFindQuery({ requests: [{ omit: false, criteria: [{ value: '', value2: '', ...criterion }] }], sort: [] }),
        limit: 500
      })
    ).data;
  const begins = await find({ field: 'FirstName', operator: 'begins', value: 'Gr' });
  check('"begins with" matches names starting with the text', begins.length > 0 && begins.every((r) => r.fieldData.FirstName.startsWith('Gr')), begins.length);
  const phrase = await find({ field: 'Notes', operator: 'contains', value: 'John Smith' });
  const reordered = await find({ field: 'Notes', operator: 'contains', value: 'Smith John' }).catch(() => []);
  check('"contains phrase" finds the phrase and not reordered words', phrase.length > 0 && reordered.length === 0, { phrase: phrase.length, reordered: reordered.length });
  const between = await find({ field: 'Amount', operator: 'between', value: '100', value2: '200' });
  check('"between" on a number', between.length > 0 && between.every((r) => r.fieldData.Amount >= 100 && r.fieldData.Amount <= 200), between.length);
  const blank = await find({ field: 'Notes', operator: 'empty' });
  check('"is empty" finds blank notes', blank.length > 0 && blank.every((r) => r.fieldData.Notes === ''), blank.length);
  const exact = await find({ field: 'Email', operator: 'equals', value: 'user7@example.com' });
  check('"equals" with @ matches one exact email', exact.length === 1, exact.length);
  const omitted = await client.findRecords(profile, 'Contacts', { query: [{ Status: 'Open' }, { Region: 'West', omit: 'true' }], limit: 500 });
  check('an omit request removes rows', omitted.data.length > 0 && omitted.data.every((r) => r.fieldData.Region !== 'West'));
  const sorted = await client.findRecords(profile, 'Contacts', { query: open, sort: [{ fieldName: 'Amount', sortOrder: 'descend' }], limit: 10 });
  const amounts = sorted.data.map((r) => r.fieldData.Amount);
  check('sort descending', amounts.every((value, index) => index === 0 || amounts[index - 1] >= value), amounts);

  // Session expiry: one renewal, even for parallel requests.
  await admin('/__admin/expire', 'POST');
  let before = await sessionPosts();
  const afterExpiry = await client.findRecords(profile, 'Invoices', { query: [{ Status: 'Open' }] }).then((r) => r.data.length, (e) => String(e.message));
  check('an expired session is renewed once and the request succeeds', typeof afterExpiry === 'number' && (await sessionPosts()) === before + 1, afterExpiry);

  await admin('/__admin/expire', 'POST');
  before = await sessionPosts();
  const parallel = await Promise.all([1, 2, 3, 4, 5].map((limit) => client.findRecords(profile, 'Invoices', { query: [{ Status: 'Open' }], limit }).then(() => 'ok', (e) => String(e.message))));
  check('five parallel requests after expiry open one session', parallel.every((r) => r === 'ok') && (await sessionPosts()) - before === 1, { parallel, opened: (await sessionPosts()) - before });

  // Records, with modId protection.
  const created = await client.createRecord(profile, 'Contacts', { FirstName: 'Test', LastName: 'Person', Email: 'test@example.com' }).catch((e) => ({ error: String(e.message) }));
  const recordId = String(created.recordId ?? '');
  check('create returns a record id', /^\d+$/.test(recordId), created);
  const loaded = await client.getRecord(profile, 'Contacts', recordId);
  const modId = String(loaded.modId ?? (loaded.data && loaded.data[0].modId) ?? '0');
  const edited = await client.editRecord(profile, 'Contacts', recordId, { Status: 'Closed' }, undefined, { modId }).catch((e) => ({ error: String(e.message) }));
  check('an edit with the loaded modId succeeds and returns the next one', !edited.error && String(edited.modId) === String(Number(modId) + 1), edited);
  const stale = await errorText(() => client.editRecord(profile, 'Contacts', recordId, { Status: 'Open' }, undefined, { modId }));
  check('a second edit on the old modId is refused (error 306)', /306|modification/i.test(stale ?? ''), stale ?? 'no error: the edit overwrote silently');
  check('an edit without a modId still works', await client.editRecord(profile, 'Contacts', recordId, { Status: 'Open' }).then(() => true, () => false));
  await client.deleteRecord(profile, 'Contacts', recordId);
  const gone = await errorText(() => client.getRecord(profile, 'Contacts', recordId));
  check('reading a deleted record gives a readable error', /101|missing|not found/i.test(gone ?? ''), gone);

  // Scripts and logout.
  check('lists scripts', (await client.listScripts(profile)).includes('Echo'));
  const ran = await client.runScript(profile, { layout: 'Contacts', scriptName: 'Echo', scriptParameter: 'hello' }).catch((e) => ({ error: String(e.message) }));
  check('runs a script and returns its result', !ran.error, ran);
  await client.deleteSession(profile);
  check('logout works', true);
}

async function main() {
  const mock = await startMock();
  let exitCode = 0;
  try {
    await runChecks();
  } catch (error) {
    console.error('check run failed:', error);
    exitCode = 2;
  } finally {
    mock.kill();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.ok ? '' : JSON.stringify(r.detail)?.slice(0, 300));
  }
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(exitCode || (failed.length ? 1 : 0));
}

main();
