// Tests for the rotation calendar parser in scripts/lib/secret-rotation.mjs.
// Run with: node --test scripts/
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseRotationCalendar,
  readRotationCalendar,
  SecretRotationParseError,
  STATUS
} from './lib/secret-rotation.mjs';

const NOW = '2026-10-24T12:00:00Z';

/** A document with a rotation calendar whose rows are the given table rows. */
function documentWith(rows, { heading = '## Rotation calendar', extra = '' } = {}) {
  return [
    '# Secrets and credentials',
    '',
    '## Inventory',
    '',
    '| Name | Where | What it is | Secret? |',
    '| --- | --- | --- | --- |',
    '| `AZURE_CLIENT_ID` | Variables | Managed identity | No |',
    '',
    heading,
    '',
    '| Name | Owner | Next rotation due | Notes |',
    '| --- | --- | --- | --- |',
    ...rows,
    extra,
    '## If you add a secret',
    '',
    '1. Prefer something that is not a secret.',
    ''
  ].join('\n');
}

const row = (name, owner, due, notes = '') => `| \`${name}\` | ${owner} | ${due} | ${notes} |`;

test('a row whose date has passed is flagged as past due', () => {
  const calendar = parseRotationCalendar(documentWith([row('OLD_PAT', 'Alan', '2026-10-01')]), {
    now: NOW
  });
  assert.equal(calendar.rows.length, 1);
  assert.equal(calendar.rows[0].status, STATUS.PAST_DUE);
  assert.equal(calendar.rows[0].daysUntil, -23);
  assert.equal(calendar.pastDue.length, 1);
  assert.equal(calendar.dueSoon.length, 0);
  assert.equal(calendar.ok.length, 0);
  assert.equal(calendar.skipped.length, 0);
});

test('a row that is due within 30 days is flagged as due soon', () => {
  const calendar = parseRotationCalendar(documentWith([row('SOON_PAT', 'Alan', '2026-11-10')]), {
    now: NOW
  });
  assert.equal(calendar.rows[0].status, STATUS.DUE_SOON);
  assert.equal(calendar.rows[0].daysUntil, 17);
  assert.equal(calendar.dueSoon.length, 1);
  assert.equal(calendar.pastDue.length, 0);
});

test('the 30 day boundary counts as due soon and 31 days does not', () => {
  const calendar = parseRotationCalendar(
    documentWith([row('EDGE_PAT', 'Alan', '2026-11-23'), row('LATER_PAT', 'Alan', '2026-11-24')]),
    { now: NOW }
  );
  assert.equal(calendar.dueSoon[0].name, 'EDGE_PAT');
  assert.equal(calendar.dueSoon[0].daysUntil, 30);
  assert.equal(calendar.ok[0].name, 'LATER_PAT');
  assert.equal(calendar.ok[0].daysUntil, 31);
});

test('a row that is due later is reported as ok and produces no reminder', () => {
  const calendar = parseRotationCalendar(documentWith([row('FUTURE_PAT', 'Alan', '2027-01-15')]), {
    now: NOW
  });
  assert.equal(calendar.rows[0].status, STATUS.OK);
  assert.equal(calendar.ok.length, 1);
  assert.equal(calendar.pastDue.length, 0);
  assert.equal(calendar.dueSoon.length, 0);
});

test('a blank or N/A date is tolerated and never produces a reminder', () => {
  const calendar = parseRotationCalendar(
    documentWith([row('BLANK_PAT', 'Alan', ''), row('NA_PAT', 'Alan', 'N/A'), row('DASH_PAT', 'Alan', '-')]),
    { now: NOW }
  );
  assert.equal(calendar.rows.length, 3);
  assert.equal(calendar.notTracked.length, 3);
  for (const entry of calendar.rows) {
    assert.equal(entry.status, STATUS.NOT_TRACKED);
    assert.equal(entry.dueDate, null);
    assert.equal(entry.daysUntil, null);
  }
  assert.equal(calendar.pastDue.length, 0);
  assert.equal(calendar.dueSoon.length, 0);
  assert.equal(calendar.skipped.length, 0);
});

test('a malformed date is skipped and reported with a reason', () => {
  const calendar = parseRotationCalendar(documentWith([row('BROKEN_PAT', 'Alan', '31/12/2026')]), {
    now: NOW
  });
  assert.equal(calendar.rows.length, 0);
  assert.equal(calendar.pastDue.length, 0);
  assert.equal(calendar.dueSoon.length, 0);
  assert.equal(calendar.skipped.length, 1);
  assert.equal(calendar.skipped[0].name, 'BROKEN_PAT');
  assert.match(calendar.skipped[0].reason, /not an ISO date/);
  assert.match(calendar.skipped[0].reason, /31\/12\/2026/);
});

test('a date that is not a real calendar day is skipped', () => {
  const calendar = parseRotationCalendar(documentWith([row('IMPOSSIBLE_PAT', 'Alan', '2026-02-31')]), {
    now: NOW
  });
  assert.equal(calendar.skipped.length, 1);
  assert.match(calendar.skipped[0].reason, /not an ISO date/);
});

test('strict mode throws instead of skipping an unusable row', () => {
  assert.throws(
    () =>
      parseRotationCalendar(documentWith([row('BROKEN_PAT', 'Alan', '31/12/2026')]), {
        now: NOW,
        strict: true
      }),
    SecretRotationParseError
  );
});

test('a row with the wrong number of cells is skipped and reported', () => {
  const calendar = parseRotationCalendar(documentWith(['| `SHORT_PAT` | Alan | 2026-11-01 |']), {
    now: NOW
  });
  assert.equal(calendar.rows.length, 0);
  assert.equal(calendar.skipped.length, 1);
  assert.match(calendar.skipped[0].reason, /3 cells/);
  assert.match(calendar.skipped[0].reason, /4/);
});

test('an empty calendar table is fine', () => {
  const calendar = parseRotationCalendar(documentWith([]), { now: NOW });
  assert.equal(calendar.sectionFound, true);
  assert.equal(calendar.rows.length, 0);
  assert.equal(calendar.pastDue.length, 0);
  assert.equal(calendar.dueSoon.length, 0);
  assert.equal(calendar.skipped.length, 0);
});

test('a missing rotation calendar section is handled without an error', () => {
  const calendar = parseRotationCalendar(
    ['# Secrets and credentials', '', '## Inventory', '', 'No table here.', ''].join('\n'),
    { now: NOW }
  );
  assert.equal(calendar.sectionFound, false);
  assert.equal(calendar.rows.length, 0);
  assert.equal(calendar.skipped.length, 0);
});

test('the comment row that ships in the table is ignored', () => {
  const calendar = parseRotationCalendar(
    documentWith(['| <!-- No tracked credentials yet: add a row here when you add a secret. --> | | | |']),
    { now: NOW }
  );
  assert.equal(calendar.rows.length, 0);
  assert.equal(calendar.skipped.length, 0);
});

test('the inventory table is not read as a rotation calendar', () => {
  const calendar = parseRotationCalendar(
    [
      '# Secrets and credentials',
      '',
      '## Inventory',
      '',
      '| Name | Owner | Next rotation due | Notes |',
      '| --- | --- | --- | --- |',
      '| `INVENTORY_PAT` | Alan | 2026-01-01 | not a calendar row |',
      ''
    ].join('\n'),
    { now: NOW }
  );
  assert.equal(calendar.sectionFound, false);
  assert.equal(calendar.rows.length, 0);
});

test('the owner, the notes and the line number are read', () => {
  const markdown = documentWith([row('OWNED_PAT', 'Alan', '2026-11-01', 'published by the release job')]);
  const calendar = parseRotationCalendar(markdown, { now: NOW });
  assert.equal(calendar.rows[0].owner, 'Alan');
  assert.equal(calendar.rows[0].notes, 'published by the release job');
  assert.equal(calendar.rows[0].name, 'OWNED_PAT');
  assert.equal(calendar.rows[0].line, markdown.split('\n').findIndex((line) => line.includes('OWNED_PAT')) + 1);
});

test('the calendar is read from a file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'secret-rotation-'));
  const file = path.join(directory, 'SECRETS.md');
  writeFileSync(file, documentWith([row('FILE_PAT', 'Alan', '2026-11-05')]), 'utf8');
  const calendar = readRotationCalendar(file, { now: NOW });
  assert.equal(calendar.rows.length, 1);
  assert.equal(calendar.rows[0].name, 'FILE_PAT');
  assert.equal(calendar.dueSoon.length, 1);
});

test('the real docs/SECRETS.md parses without a skip', () => {
  const file = fileURLToPath(new URL('../docs/SECRETS.md', import.meta.url));
  const calendar = readRotationCalendar(file, { now: NOW });
  assert.equal(calendar.sectionFound, true);
  assert.deepEqual(calendar.skipped, []);
});

test('a section without a rotation table is reported instead of ignored', () => {
  const calendar = parseRotationCalendar(
    ['# Secrets', '', '## Rotation calendar', '', 'Nothing here yet.', ''].join('\n'),
    { now: NOW }
  );
  assert.equal(calendar.sectionFound, true);
  assert.equal(calendar.rows.length, 0);
  assert.equal(calendar.skipped.length, 1);
  assert.match(calendar.skipped[0].reason, /no rotation table/);
});

test('the within-days window is configurable', () => {
  const markdown = documentWith([row('WINDOW_PAT', 'Alan', '2026-11-20')]);
  const narrow = parseRotationCalendar(markdown, { now: NOW, withinDays: 7 });
  assert.equal(narrow.ok.length, 1);
  const wide = parseRotationCalendar(markdown, { now: NOW, withinDays: 60 });
  assert.equal(wide.dueSoon.length, 1);
});

test('a name that appears twice is skipped and reported, and neither row reminds', () => {
  const calendar = parseRotationCalendar(
    documentWith([row('TWICE_PAT', 'Alan', '2026-11-01'), row('TWICE_PAT', 'Alan', '2026-12-01')]),
    { now: NOW }
  );
  assert.equal(calendar.rows.length, 0);
  assert.equal(calendar.pastDue.length, 0);
  assert.equal(calendar.dueSoon.length, 0);
  assert.equal(calendar.ok.length, 0);
  assert.equal(calendar.skipped.length, 2);
  assert.equal(calendar.skipped[0].name, 'TWICE_PAT');
  assert.equal(calendar.skipped[1].name, 'TWICE_PAT');
  assert.match(calendar.skipped[0].reason, /appears more than once/);
  assert.notEqual(calendar.skipped[0].line, calendar.skipped[1].line);
});

test('only the duplicated name is dropped; the other rows still count', () => {
  const calendar = parseRotationCalendar(
    documentWith([
      row('GOOD_PAT', 'Alan', '2026-11-01'),
      row('TWICE_PAT', 'Alan', '2026-11-02'),
      row('OTHER_PAT', 'Alan', '2026-11-03'),
      row('TWICE_PAT', 'Alan', '2026-11-04')
    ]),
    { now: NOW }
  );
  assert.deepEqual(
    calendar.rows.map((entry) => entry.name),
    ['GOOD_PAT', 'OTHER_PAT']
  );
  assert.equal(calendar.dueSoon.length, 2);
  assert.equal(calendar.skipped.length, 2);
  assert.ok(calendar.skipped.every((entry) => entry.name === 'TWICE_PAT'));
});

test('a name that appears twice is a duplicate even when one row has no date', () => {
  const calendar = parseRotationCalendar(
    documentWith([row('TWICE_PAT', 'Alan', '2026-11-01'), row('TWICE_PAT', 'Alan', '')]),
    { now: NOW }
  );
  assert.equal(calendar.rows.length, 0);
  assert.equal(calendar.notTracked.length, 0);
  assert.equal(calendar.skipped.length, 2);
});

test('strict mode throws on a duplicated name', () => {
  assert.throws(
    () =>
      parseRotationCalendar(
        documentWith([row('TWICE_PAT', 'Alan', '2026-11-01'), row('TWICE_PAT', 'Alan', '2026-12-01')]),
        { now: NOW, strict: true }
      ),
    SecretRotationParseError
  );
});
