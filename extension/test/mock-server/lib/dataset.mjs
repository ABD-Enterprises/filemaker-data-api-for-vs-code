// Deterministic sample solutions for the mock Data API. Everything here is derived from a seed
// (no clock, no Math.random), so a run is repeatable and `manifest.json` stays in step.
//
// Databases
//   Sales      small baseline kept stable for existing tests (Contacts 157, Invoices 12)
//   Quality    deliberately mixed-quality data: clean majority plus empty, huge, Unicode, hostile,
//              malformed-number/date, container, repetition and portal cases
//   Inventory  small clean database (second connection target)
//   Locked     listed but refuses to open (error 802)
// `manifest` records which record ids exercise which condition (see DATASET.md).
import { makeRng } from './prng.mjs';
import * as S from './samples.mjs';

export const DEFAULT_SEED = 20261018;

export const CONDITIONS = {
  clean: 'Typical well-formed record.',
  'empty-strings': 'Text fields that are empty strings.',
  'whitespace-only': 'Text fields holding only spaces, tabs or newlines.',
  'missing-fields': 'fieldData lacks keys the layout defines (a real server always sends every layout field; tests robustness).',
  'null-like': 'Strings such as null, NULL, undefined, N/A, nil.',
  'long-text-12k': 'About 12,000 characters in Notes.',
  'long-text-60k': 'About 60,000 characters in Bio.',
  'long-text-300k': 'About 300,000 characters in Bio (response-size limit pressure).',
  multiline: 'Values with LF, CRLF, CR, tab, U+2028 line breaks.',
  unicode: 'CJK, RTL, emoji, combining marks, zero-width, bidi controls, homoglyphs, full-width, control characters.',
  'edge-spaces': 'Leading and trailing spaces.',
  'case-duplicates': 'Names equal ignoring case.',
  'near-duplicates': 'Near-identical names (Jon/John/Jonn).',
  'numbers-as-text': 'Numbers stored in a text field in many formats (BalanceText).',
  'numbers-extreme': 'Negative, huge, tiny, -0 and 2^53+ numbers in a number field.',
  'date-formats': 'Dates and timestamps in many formats, invalid and out-of-range values.',
  'date-empty': 'Empty date.',
  repetitions: 'Repeating field Phones with some repetitions empty.',
  'container-normal': 'Container with a streaming URL.',
  'container-empty': 'Empty container.',
  'container-huge': 'Container whose streaming URL serves about 25 MB.',
  'container-hostile-name': 'Container URL with traversal or NUL in the file name.',
  'portal-0': 'Customer with 0 related Orders.',
  'portal-1': 'Customer with exactly 1 related Order.',
  'portal-many': 'Customer with 170 related Orders (beyond the 50-row default portal page).',
  'portal-empty-rows': 'Related rows whose fields are empty.',
  'csv-formula': 'CSV formula starters (=, +, -, @, tab, CR, leading apostrophe, full-width =).',
  'json-like': 'Values that look like JSON.',
  'html-script': 'HTML and script strings.',
  'markdown-breaker': 'Markdown and code-fence breakers.',
  'prompt-injection': 'Text that tries to instruct an AI assistant, plus *** and [hidden] look-alikes.',
  'secret-like': 'Values shaped like tokens, keys and passwords.',
  'host-like': 'Values containing the mock host, an IP address, or the caller\'s own session token.',
  'sensitive-fields': 'SSN, Password and Token fields (candidates for hidden fields).',
  'hostile-fieldnames': 'Layout whose field names include .., slashes, quotes, backticks, Table::Field, RecordID, modId, CON, NUL, __proto__, 130+ chars.',
  'hostile-layoutnames': 'Layouts whose names include .., slashes, quotes, backticks, CON, NUL, __proto__, 130+ chars.',
  'non-contiguous-ids': 'Record ids skip numbers (deleted gaps).',
  'modid-varied': 'modId values other than 0.'
};

const iso = (y, m, d) => `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
const ts = (y, m, d, h, mi, s) => `${iso(y, m, d)} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
const f = (name, result = 'text', extra = {}) => ({ name, result, type: 'normal', repetitions: 1, global: false, ...extra });

export function buildDataset(seed = DEFAULT_SEED) {
  const rng = makeRng(seed);
  const manifest = { seed, conditions: CONDITIONS, databases: {} };
  const databases = {};

  // ---- helpers -------------------------------------------------------------------------------
  const tagsFor = (db, table) => ((manifest.databases[db] ??= { tables: {} }).tables[table] ??= { recordCount: 0, conditions: {}, deletedIdGaps: [] });
  // Assign record ids (non-contiguous) and modIds, record tags into the manifest.
  function load(db, table, items, { startId, gaps = true, shuffle = true, modIds = true }) {
    const order = shuffle ? rng.shuffle(items) : items;
    const info = tagsFor(db.name, table.name);
    let id = startId;
    for (const item of order) {
      if (gaps && rng.chance(0.18)) {
        const skip = rng.int(1, 3);
        for (let k = 0; k < skip; k += 1) info.deletedIdGaps.push(String(id + k));
        id += skip;
      }
      const modId = modIds && rng.chance(0.3) ? rng.int(1, 87) : 0;
      const row = { recordId: String(id), modId: String(modId), fieldData: item.fieldData };
      table.rows.push(row);
      const tags = new Set(item.tags ?? ['clean']);
      if (modId > 0) tags.add('modid-varied');
      for (const t of tags) (info.conditions[t] ??= []).push(row.recordId);
      id += 1;
    }
    table.nextRecordId = id + 10;
    info.recordCount = table.rows.length;
    if (info.deletedIdGaps.length) (info.conditions['non-contiguous-ids'] ??= []).push(...info.deletedIdGaps.map((g) => `gap:${g}`));
    return table.rows;
  }
  const newDb = (name, extra = {}) => ({ name, tables: {}, layouts: [], scripts: [], valueLists: {}, ...extra });
  const newTable = (db, name, fields) => (db.tables[name] = { name, fields, rows: [], nextRecordId: 1 });

  // ---- Sales (baseline, unchanged data) ------------------------------------------------------
  {
    const db = newDb('Sales');
    const fields = [
      f('FirstName'), f('LastName'), f('Email'), f('Status'), f('Amount', 'number'), f('Region'), f('Notes'), f('Created', 'date')
    ];
    const contacts = newTable(db, 'Contacts', fields);
    for (let i = 1; i <= 157; i += 1) {
      contacts.rows.push({
        recordId: String(1000 + i), modId: '0',
        fieldData: {
          FirstName: S.FIRST[i % 8], LastName: S.LAST[(i * 3) % 8], Email: `user${i}@example.com`, Status: i % 3 ? 'Open' : 'Closed',
          Amount: (i * 37) % 500, Region: ['West', 'East', 'North'][i % 3], Notes: i % 10 === 0 ? '' : `Customer note ${i}: John Smith visited on site`,
          Created: `10/${1 + (i % 28)}/2026`
        }
      });
    }
    contacts.nextRecordId = 5000;
    const inv = newTable(db, 'Invoices', [f('Invoice'), f('Customer'), f('Balance', 'number'), f('Status')]);
    for (let i = 1; i <= 12; i += 1) inv.rows.push({ recordId: String(2000 + i), modId: '0', fieldData: { Invoice: `INV-${1040 + i}`, Customer: `Customer ${i}`, Balance: i * 125.5, Status: i % 2 ? 'Open' : 'Paid' } });
    // Shared id counter: the baseline mock gave new records ids from one counter starting at 5000.
    inv.nextRecordId = 5000;
    db.layouts = [{ name: 'Contacts', table: 'Contacts', fields: fields.map((x) => x.name) }, { name: 'Invoices', table: 'Invoices', fields: inv.fields.map((x) => x.name) }];
    db.scripts = [{ name: 'Rebuild Index', isFolder: false }, { name: 'Echo', isFolder: false }];
    db.sharedIdCounter = true;
    databases.Sales = db;
    tagsFor('Sales', 'Contacts').recordCount = 157;
    tagsFor('Sales', 'Invoices').recordCount = 12;
  }

  // ---- Quality -------------------------------------------------------------------------------
  const Q = newDb('Quality');
  Q.valueLists = {
    Status: S.STATUSES,
    Region: S.REGIONS,
    Category: ['Hardware', 'Software', 'Services', 'Other']
  };
  const customerFields = [
    f('CustomerID', 'text', { unique: true, autoEnter: true }), f('FirstName'), f('LastName', 'text', { notEmpty: true }),
    f('FullName', 'text', { type: 'calculation' }), f('Email'), f('Phone'), f('Phones', 'text', { repetitions: 3 }), f('Company'),
    f('Status', 'text', { valueList: 'Status' }), f('Region', 'text', { valueList: 'Region' }), f('Balance', 'number'), f('BalanceText'),
    f('Rating', 'number'), f('Joined', 'date'), f('LastContact', 'timeStamp'), f('BirthDate', 'date'), f('Notes'), f('Bio'),
    f('Avatar', 'container'), f('Brochure', 'container'), f('OrderCount', 'number', { type: 'calculation' }), f('TotalOrdered', 'number', { type: 'summary' }),
    f('gFilter', 'text', { global: true }), f('SSN'), f('Password'), f('Token'), f('InternalUrl')
  ];
  const customers = newTable(Q, 'Customers', customerFields);
  const orders = newTable(Q, 'Orders', [f('OrderID', 'text', { unique: true }), f('CustomerID'), f('OrderDate', 'date'), f('Total', 'number'), f('Status'), f('Notes'), f('LineCount', 'number', { type: 'calculation' })]);
  const lines = newTable(Q, 'LineItems', [f('LineID'), f('OrderID'), f('SKU'), f('Qty', 'number'), f('Price', 'number'), f('Description')]);
  const notes = newTable(Q, 'CustomerNotes', [f('NoteID'), f('CustomerID'), f('Body'), f('Created', 'timeStamp')]);

  const orderItems = [];
  const lineItems = [];
  const noteItems = [];
  let orderSeq = 10000;
  const addOrders = (customerId, count, { emptyRows = 0, tag } = {}) => {
    for (let k = 0; k < count; k += 1) {
      const empty = k < emptyRows;
      orderSeq += 1;
      const fd = empty
        ? { OrderID: `O-${orderSeq}`, CustomerID: customerId, OrderDate: '', Total: '', Status: '', Notes: '' }
        : { OrderID: `O-${orderSeq}`, CustomerID: customerId, OrderDate: iso(2026, rng.int(1, 12), rng.int(1, 28)), Total: Math.round(rng.next() * 100000) / 100, Status: rng.pick(['Paid', 'Open', 'Shipped']), Notes: rng.chance(0.3) ? `Order note ${orderSeq}` : '' };
      orderItems.push({ fieldData: fd, tags: empty ? ['portal-empty-rows'] : tag ? [tag] : ['clean'] });
      if (!empty && rng.chance(0.3)) {
        for (let l = 0, n = rng.int(1, 3); l < n; l += 1) {
          lineItems.push({ fieldData: { LineID: `L-${orderSeq}-${l + 1}`, OrderID: fd.OrderID, SKU: `SKU-${rng.int(1, 60)}`, Qty: rng.int(1, 9), Price: rng.int(1, 500), Description: l === 1 ? '' : `Line ${l + 1} of ${fd.OrderID}` } });
        }
      }
    }
  };

  let customerSeq = 0;
  const cleanCustomer = () => {
    customerSeq += 1;
    const first = rng.pick(S.FIRST);
    const last = rng.pick(S.LAST);
    const balance = Math.round((rng.next() * 20000 - 2000) * 100) / 100;
    const n = customerSeq;
    return {
      CustomerID: `C-${String(n).padStart(4, '0')}`, FirstName: first, LastName: last, Email: `${first}.${last}${n}@example.com`.toLowerCase(),
      Phone: `555-01${String(n % 100).padStart(2, '0')}`, 'Phones(1)': `555-02${String(n % 100).padStart(2, '0')}`, 'Phones(2)': '', 'Phones(3)': '',
      Company: rng.pick(S.COMPANIES), Status: rng.pick(S.STATUSES), Region: rng.pick(S.REGIONS), Balance: balance, BalanceText: balance.toFixed(2), Rating: rng.int(1, 5),
      Joined: iso(2020 + (n % 6), 1 + (n % 12), 1 + (n % 28)), LastContact: ts(2026, 1 + (n % 12), 1 + (n % 28), n % 24, n % 60, 0), BirthDate: iso(1960 + (n % 40), 1 + (n % 12), 1 + (n % 28)),
      Notes: rng.chance(0.2) ? '' : `Customer note ${n}: prefers email contact`, Bio: `${first} ${last} works at a company and likes ${rng.pick(['chess', 'sailing', 'rust', 'jazz'])}.`,
      Avatar: rng.chance(0.7) ? `/Streaming_SSL/MainDB/avatar-${n}.png?RCType=EmbeddedRCFileProcessor` : '', Brochure: '',
      SSN: `900-${String(10 + (n % 80)).padStart(2, '0')}-${String(1000 + n).slice(-4)}`, Password: `pw-${n}-not-a-real-password`, Token: `tok_test_${String(n).padStart(8, '0')}`, InternalUrl: ''
    };
  };
  const customerItems = [];
  const custItem = (tags, patch = {}, ordersSpec = {}) => {
    const fd = { ...cleanCustomer(), ...patch };
    customerItems.push({ fieldData: fd, tags });
    const count = ordersSpec.count ?? (rng.chance(0.4) ? 0 : rng.chance(0.4) ? 1 : rng.int(2, 5));
    addOrders(fd.CustomerID, count, ordersSpec);
    if (rng.chance(0.3)) for (let k = 0, n = rng.int(1, 3); k < n; k += 1) noteItems.push({ fieldData: { NoteID: `N-${fd.CustomerID}-${k + 1}`, CustomerID: fd.CustomerID, Body: k === 0 ? '' : `Follow-up ${k}`, Created: ts(2026, 3, 1 + k, 9, 0, 0) } });
    return fd;
  };

  // portal cases
  custItem(['portal-many'], { Company: 'Portal Heavy Co' }, { count: 170, emptyRows: 6 });
  custItem(['portal-1'], { Company: 'Single Order Co' }, { count: 1 });
  custItem(['portal-0'], { Company: 'No Order Co' }, { count: 0 });
  custItem(['portal-empty-rows'], { Company: 'Blank Rows Co' }, { count: 4, emptyRows: 3 });
  // empty and null-like
  for (let k = 0; k < 4; k += 1) custItem(['empty-strings'], { Email: '', Phone: '', Company: '', Notes: '', Bio: '', Status: '', Region: '' });
  for (let k = 0; k < 4; k += 1) custItem(['whitespace-only'], { Company: '   ', Notes: ['\t', '\n', ' \r\n ', ' 　'][k], Bio: '  ' });
  for (let k = 0; k < 3; k += 1) custItem(['missing-fields'], {}).Email = undefined;
  // (undefined keys are removed after assembly below)
  for (const word of ['null', 'NULL', 'undefined', 'N/A']) custItem(['null-like'], { Notes: word, Company: word, Email: word });
  // long and multi-line text
  custItem(['long-text-12k'], { Notes: 'Lorem ipsum dolor sit amet. '.repeat(430) });
  custItem(['long-text-60k'], { Bio: 'x'.repeat(59990) + ' tail-marker' });
  custItem(['long-text-300k'], { Bio: 'y'.repeat(299990) + ' tail-marker' });
  custItem(['multiline'], { Notes: 'line1\nline2\nline3' });
  custItem(['multiline'], { Notes: 'crlf1\r\ncrlf2\r\n' });
  custItem(['multiline'], { Notes: 'cr1\rcr2\ttab ls ps' });
  // unicode
  for (const [kind, list] of Object.entries(S.UNICODE)) {
    custItem(['unicode'], { FirstName: list[0], LastName: list[1] ?? list[0], Company: `${kind}: ${list.join(' | ')}`, Notes: list.join('\n') });
  }
  // spacing, case and near duplicates
  custItem(['edge-spaces'], { FirstName: '  Padded', LastName: 'Name  ', Email: ' spaced@example.com ' });
  custItem(['edge-spaces'], { FirstName: '\tTabbed', LastName: 'Name\t' });
  for (const [first, last] of [['ada', 'lovelace'], ['ADA', 'LOVELACE'], ['Ada', 'Lovelace']]) custItem(['case-duplicates'], { FirstName: first, LastName: last, Email: 'ada.dup@example.com' });
  for (const first of ['Jon', 'John', 'Jonn']) custItem(['near-duplicates'], { FirstName: first, LastName: 'Smith', Email: 'jsmith@example.com' });
  // numbers and dates
  S.NUMBER_TEXT.slice(0, 12).forEach((text, k) => custItem(['numbers-as-text'], { BalanceText: text, Balance: [0, -0, -1234.5, 1e308, 5e-324, 9007199254740991, -9007199254740991, 1e21, 123456789.123456789, 0.1 + 0.2, 100, 1e-7][k] }));
  custItem(['numbers-extreme'], { Balance: -1e21, BalanceText: '-1e21' });
  S.DATE_TEXT.slice(0, 10).forEach((text, k) => custItem(['date-formats'], { Joined: text, BirthDate: S.DATE_TEXT[(k + 3) % 16], LastContact: S.TIMESTAMP_TEXT[k % 12] }));
  custItem(['date-empty'], { Joined: '', BirthDate: '', LastContact: '' });
  // repetitions
  custItem(['repetitions'], { 'Phones(1)': '555-1111', 'Phones(2)': '', 'Phones(3)': '555-3333' });
  custItem(['repetitions'], { 'Phones(1)': '', 'Phones(2)': '555-2222', 'Phones(3)': '' });
  // containers
  custItem(['container-normal'], { Avatar: '/Streaming_SSL/MainDB/avatar-special.png?RCType=EmbeddedRCFileProcessor', Brochure: '/Streaming_SSL/MainDB/brochure.pdf?RCType=EmbeddedRCFileProcessor' });
  custItem(['container-empty'], { Avatar: '', Brochure: '' });
  custItem(['container-huge'], { Avatar: '/Streaming_SSL/MainDB/huge-avatar.bin?RCType=EmbeddedRCFileProcessor' });
  custItem(['container-hostile-name'], { Avatar: '/Streaming_SSL/MainDB/..%2F..%2Fetc%2Fpasswd?RCType=EmbeddedRCFileProcessor', Brochure: '/Streaming_SSL/MainDB/a%00b.png' });
  // hostile content in ordinary text fields
  S.FORMULA_STARTERS.forEach((v) => custItem(['csv-formula'], { Notes: v, Company: v, LastName: `Formula${customerSeq}` }));
  S.JSON_LIKE.forEach((v) => custItem(['json-like'], { Notes: v, Company: v }));
  S.HTML_LIKE.forEach((v) => custItem(['html-script'], { Notes: v, Company: v, LastName: v }));
  S.MARKDOWN_BREAKERS.forEach((v) => custItem(['markdown-breaker'], { Notes: v, Company: v }));
  S.PROMPT_INJECTION.forEach((v) => custItem(['prompt-injection'], { Notes: v, Company: v }));
  S.SECRET_LIKE.forEach((v) => custItem(['secret-like'], { Notes: v, InternalUrl: v }));
  S.HOST_LIKE.forEach((v) => custItem(['host-like'], { Notes: v, InternalUrl: v }));
  // sensitive-looking fields on a few clean records
  for (let k = 0; k < 4; k += 1) custItem(['sensitive-fields'], {});
  // top up with clean records: clean is the majority (about 75 of 220)
  while (customerItems.length < 220) custItem(['clean'], {});
  // drop explicitly-undefined keys ("missing fields")
  for (const item of customerItems) for (const k of Object.keys(item.fieldData)) if (item.fieldData[k] === undefined) delete item.fieldData[k];
  for (const item of customerItems) if (item.tags.includes('missing-fields')) { delete item.fieldData.Phone; delete item.fieldData['Phones(1)']; }

  load(Q, customers, customerItems, { startId: 3001 });
  load(Q, orders, orderItems, { startId: 7001 });
  load(Q, lines, lineItems, { startId: 9001 });
  load(Q, notes, noteItems, { startId: 11001 });

  // Products (clean)
  const products = newTable(Q, 'Products', [f('SKU', 'text', { unique: true }), f('Name'), f('Category', 'text', { valueList: 'Category' }), f('Price', 'number'), f('InStock', 'number'), f('Description')]);
  const productItems = [];
  for (let i = 1; i <= 60; i += 1) productItems.push({ fieldData: { SKU: `SKU-${i}`, Name: `Product ${i}`, Category: rng.pick(Q.valueLists.Category), Price: rng.int(1, 999) + 0.99, InStock: rng.int(0, 500), Description: i % 7 === 0 ? '' : `Description of product ${i}` } });
  load(Q, products, productItems, { startId: 5001 });

  // Documents (containers)
  const docs = newTable(Q, 'Documents', [f('DocID'), f('Title'), f('File', 'container'), f('Thumb', 'container'), f('Kind')]);
  const docItems = [];
  for (let i = 1; i <= 15; i += 1) docItems.push({ tags: ['container-normal'], fieldData: { DocID: `D-${i}`, Title: `Document ${i}`, File: `/Streaming_SSL/MainDB/doc-${i}.pdf?RCType=EmbeddedRCFileProcessor`, Thumb: `/Streaming_SSL/MainDB/thumb-${i}.png?RCType=EmbeddedRCFileProcessor`, Kind: 'pdf' } });
  for (let i = 16; i <= 20; i += 1) docItems.push({ tags: ['container-empty'], fieldData: { DocID: `D-${i}`, Title: `Empty ${i}`, File: '', Thumb: '', Kind: '' } });
  for (let i = 21; i <= 23; i += 1) docItems.push({ tags: ['container-huge'], fieldData: { DocID: `D-${i}`, Title: `Huge ${i}`, File: `/Streaming_SSL/MainDB/huge-${i}.bin?RCType=EmbeddedRCFileProcessor`, Thumb: '', Kind: 'bin' } });
  ['..%2F..%2Fetc%2Fpasswd', 'a%00b.png'].forEach((name, k) => docItems.push({ tags: ['container-hostile-name'], fieldData: { DocID: `D-${24 + k}`, Title: `Hostile ${k}`, File: `/Streaming_SSL/MainDB/${name}`, Thumb: '', Kind: '?' } }));
  for (let i = 26; i <= 30; i += 1) docItems.push({ tags: ['container-normal'], fieldData: { DocID: `D-${i}`, Title: `Odd ext ${i}`, File: `/Streaming_SSL/MainDB/file-${i}.${['tar.gz', 'HTM', 'svg', 'exe', ''][i - 26]}?RCType=EmbeddedRCFileProcessor`, Thumb: '', Kind: 'misc' } });
  load(Q, docs, docItems, { startId: 6001 });

  // Dates
  const dates = newTable(Q, 'Dates', [f('Label'), f('DateField', 'date'), f('TimestampField', 'timeStamp'), f('TimeField', 'time')]);
  const dateItems = [];
  S.DATE_TEXT.forEach((v, k) => dateItems.push({ tags: [v === '' ? 'date-empty' : 'date-formats'], fieldData: { Label: `date-${k}`, DateField: v, TimestampField: S.TIMESTAMP_TEXT[k % 12], TimeField: ['14:30:00', '25:61:61', '', '12:00:00 PM'][k % 4] } }));
  S.TIMESTAMP_TEXT.forEach((v, k) => dateItems.push({ tags: ['date-formats'], fieldData: { Label: `timestamp-${k}`, DateField: iso(2026, 1 + k, 1 + k), TimestampField: v, TimeField: '' } }));
  for (let k = 0; k < 12; k += 1) dateItems.push({ fieldData: { Label: `clean-${k}`, DateField: iso(2025, 1 + k, 15), TimestampField: ts(2025, 1 + k, 15, 8 + k, 5, 9), TimeField: `${String(8 + k).padStart(2, '0')}:05:09` } });
  load(Q, dates, dateItems, { startId: 8001 });

  // Numbers
  const numbers = newTable(Q, 'Numbers', [f('Label'), f('NumberField', 'number'), f('TextNumber')]);
  const numItems = [];
  const nums = [0, -1, -0.5, 1e308, -1e308, 5e-324, 9007199254740991, 1e21, 1e-7, 0.1 + 0.2, 123456789012345680000, 3.14159265358979, 2147483648, -2147483649, 1, 42, 1000000, 7.5, 99.99, 0.001];
  nums.forEach((v, k) => numItems.push({ tags: [k < 14 ? 'numbers-extreme' : 'clean'], fieldData: { Label: `num-${k}`, NumberField: v, TextNumber: String(v) } }));
  S.NUMBER_TEXT.forEach((v, k) => numItems.push({ tags: ['numbers-as-text'], fieldData: { Label: `text-${k}`, NumberField: '', TextNumber: v } }));
  load(Q, numbers, numItems, { startId: 12001 });

  // Unicode
  const uni = newTable(Q, 'UnicodeSamples', [f('Label'), f('Category'), f('Value')]);
  const uniItems = [];
  for (const [kind, list] of Object.entries(S.UNICODE)) list.forEach((v, k) => uniItems.push({ tags: ['unicode'], fieldData: { Label: `${kind}-${k}`, Category: kind, Value: v } }));
  load(Q, uni, uniItems, { startId: 13001 });

  // Hostile field names
  const longName = `VeryLong${'X'.repeat(130)}`;
  const hostileFieldNames = ['RecordID', 'modId', 'recordId', 'Customers::Name', 'Name', 'Orders::Total', 'a..b', '../x', 'a/b', 'quote"d', 'back`tick', 'CON', 'NUL', 'prn.txt', '__proto__', 'constructor', 'toString', 'with space', 'with\ttab', '<b>html</b>', '${x}', "x'; DROP TABLE y;--", 'emoji🚀', longName, 'Name(1)', 'éé', 'class', 'default', '123', 'ünïcödé'];
  const hostile = newTable(Q, 'Hostile', hostileFieldNames.map((n) => f(n)));
  const pools = [S.FORMULA_STARTERS, S.JSON_LIKE, S.HTML_LIKE, S.MARKDOWN_BREAKERS, S.PROMPT_INJECTION, S.SECRET_LIKE, S.HOST_LIKE, Object.values(S.UNICODE).flat()];
  const poolTags = ['csv-formula', 'json-like', 'html-script', 'markdown-breaker', 'prompt-injection', 'secret-like', 'host-like', 'unicode'];
  const hostileItems = [];
  for (let i = 0; i < 60; i += 1) {
    const pool = i % pools.length;
    const fd = Object.fromEntries(hostileFieldNames.map((n, k) => [n, pools[pool][(i + k) % pools[pool].length]]));
    fd.RecordID = i % 2 ? '999999' : String(3001 + i);
    fd.modId = i % 2 ? '-1' : '0';
    hostileItems.push({ tags: ['hostile-fieldnames', poolTags[pool]], fieldData: fd });
  }
  load(Q, hostile, hostileItems, { startId: 14001 });

  // Layout-name probes: one tiny table behind many hostile layout names
  const probe = newTable(Q, 'NameProbe', [f('Name'), f('Value')]);
  load(Q, probe, [1, 2, 3].map((k) => ({ tags: ['hostile-layoutnames'], fieldData: { Name: `probe-${k}`, Value: `value-${k}` } })), { startId: 15001, gaps: false });
  const hostileLayoutNames = ['A/B', ' Sales', 'Percent%20Layout', 'Ünïcode Lay\u00f6ut', 'Question?Mark', '../../etc/passwd', 'a/b\\c', 'Quote"Layout', 'Back`tick', 'CON', 'NUL', 'Layout::With::Colons', '<script>alert(1)</script>', '..%2f..%2fsecret', '${process.env.HOME}', '__proto__', `Long${'L'.repeat(140)}`, 'emoji 🚀 layout', '  leading space', 'tab\there', 'question?mark&amp=1'];

  const names = (t) => Q.tables[t].fields.map((x) => x.name);
  Q.layouts = [
    { name: 'Customers', table: 'Customers', fields: names('Customers').filter((n) => n !== 'Phones' && n !== 'gFilter').concat(['Phones', 'gFilter']), portals: [
      { name: 'Orders', table: 'Orders', local: 'CustomerID', foreign: 'CustomerID', fields: ['OrderID', 'OrderDate', 'Total', 'Status', 'Notes'] },
      { name: 'CustomerNotes', table: 'CustomerNotes', local: 'CustomerID', foreign: 'CustomerID', fields: ['NoteID', 'Body', 'Created'] }
    ] },
    { name: 'Orders', table: 'Orders', fields: names('Orders'), portals: [{ name: 'LineItems', table: 'LineItems', local: 'OrderID', foreign: 'OrderID', fields: ['LineID', 'SKU', 'Qty', 'Price', 'Description'] }] },
    { name: 'LineItems', table: 'LineItems', fields: names('LineItems') },
    { name: 'Products', table: 'Products', fields: names('Products') },
    { name: 'Documents', table: 'Documents', fields: names('Documents') },
    { name: 'Dates', table: 'Dates', fields: names('Dates') },
    { name: 'Numbers', table: 'Numbers', fields: names('Numbers') },
    { name: 'UnicodeSamples', table: 'UnicodeSamples', fields: names('UnicodeSamples') },
    { name: 'Hostile', table: 'Hostile', fields: names('Hostile') },
    { name: 'CustomersList', table: 'Customers', fields: ['CustomerID', 'FullName', 'Email', 'Status', 'Region', 'Balance'], folder: ['Reports'] },
    { name: 'Customers 2019', table: 'Customers', fields: ['CustomerID', 'FirstName', 'LastName', 'Joined'], folder: ['Reports', 'Archive'] },
    ...hostileLayoutNames.map((name) => ({ name, table: 'NameProbe', fields: ['Name', 'Value'] })),
    // the same name twice: once at the top level and once inside a folder
    { name: 'Customers', table: 'Customers', fields: ['CustomerID', 'FirstName', 'LastName'], folder: ['Reports', 'Archive'] }
  ];
  Q.scripts = [
    { name: 'Echo', isFolder: false }, { name: 'Rebuild Index', isFolder: false }, { name: 'Fail', isFolder: false }, { name: 'Slow', isFolder: false },
    { name: 'Create Customer', isFolder: false }, { name: 'Count Customers', isFolder: false }, { name: 'Big Result', isFolder: false }, { name: 'Needs Admin', isFolder: false },
    { name: '-', isFolder: false },
    { name: 'Maintenance', isFolder: true, folderScriptNames: [{ name: 'Purge Cache', isFolder: false }, { name: 'Deep', isFolder: true, folderScriptNames: [{ name: 'Reindex All', isFolder: false }] }] }
  ];
  Q.hasSummary = true;
  databases.Quality = Q;

  // ---- Inventory -----------------------------------------------------------------------------
  const inv = newDb('Inventory');
  const items = newTable(inv, 'Items', [f('ItemID'), f('Name'), f('Qty', 'number'), f('Location')]);
  load(inv, items, Array.from({ length: 40 }, (_, i) => ({ fieldData: { ItemID: `I-${i + 1}`, Name: `Item ${i + 1}`, Qty: (i * 7) % 50, Location: `Aisle ${1 + (i % 6)}` } })), { startId: 100, gaps: false, shuffle: false });
  inv.layouts = [{ name: 'Items', table: 'Items', fields: items.fields.map((x) => x.name) }];
  inv.scripts = [{ name: 'Echo', isFolder: false }];
  databases.Inventory = inv;

  databases.Locked = newDb('Locked', { refuses: true });

  // Totals
  manifest.totals = Object.fromEntries(Object.entries(manifest.databases).map(([name, d]) => [name, Object.values(d.tables).reduce((n, t) => n + t.recordCount, 0)]));
  manifest.hostileLayoutNames = hostileLayoutNames;
  manifest.hostileFieldNames = hostileFieldNames;
  return { databases, manifest };
}
