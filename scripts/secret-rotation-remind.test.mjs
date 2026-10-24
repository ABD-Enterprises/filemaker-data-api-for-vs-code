// Tests for the reminder runner in scripts/secret-rotation-remind.mjs.
// Run with: node --test scripts/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  commentBody,
  ensureLabel,
  findReminderIssue,
  issueBody,
  issueTitle
} from './secret-rotation-remind.mjs';

const scriptPath = fileURLToPath(new URL('./secret-rotation-remind.mjs', import.meta.url));

const pastDue = {
  name: 'VSCE_PAT',
  owner: 'Alan',
  notes: 'published by the release job',
  dueDate: '2026-10-01',
  status: 'past-due',
  daysUntil: -23,
  line: 12
};

const dueSoon = {
  name: 'PRS_PAT',
  owner: '',
  notes: '',
  dueDate: '2026-11-05',
  status: 'due-soon',
  daysUntil: 12,
  line: 13
};

test('the open issue that tracks the credential is found by its title', () => {
  const issues = [
    { number: 1, title: 'Rotate PRS_PAT by 2026-11-05', url: 'https://example.invalid/1' },
    { number: 2, title: 'Something else entirely', url: 'https://example.invalid/2' }
  ];
  assert.equal(findReminderIssue(issues, 'PRS_PAT')?.number, 1);
});

test('an issue that does not mention the credential is not used', () => {
  const issues = [{ number: 3, title: 'Rotate the marketplace certificate', url: 'https://example.invalid/3' }];
  assert.equal(findReminderIssue(issues, 'VSCE_PAT'), undefined);
});

test('the title of a reminder issue names the credential and its due date', () => {
  assert.equal(issueTitle(pastDue), 'Rotate VSCE_PAT by 2026-10-01');
});

test('the body of a new issue holds the checklist and the due date', () => {
  const body = issueBody(pastDue);
  assert.match(body, /Rotation reminder for \*\*VSCE_PAT\*\*/);
  assert.match(body, /2026-10-01 \(23 days overdue\)/);
  assert.match(body, /Owner: Alan/);
  assert.match(body, /published by the release job/);
  assert.match(body, /- \[ \] Rotate it at the source/);
  assert.match(body, /- \[ \] Set the next rotation date/);
});

test('a row without an owner still produces a readable body', () => {
  const body = issueBody(dueSoon);
  assert.match(body, /Owner: _not recorded_/);
  assert.match(body, /2026-11-05 \(in 12 days\)/);
});

test('the body of a comment says what is due and where the calendar is', () => {
  const body = commentBody(dueSoon);
  assert.match(body, /Rotation reminder: \*\*PRS_PAT\*\* is due 2026-11-05 \(in 12 days\)/);
  assert.match(body, /Rotation calendar/);
  assert.doesNotMatch(body, /- \[ \]/);
});

// A credential whose name starts with the name of another one (a rename that
// left the old name in the calendar) must not borrow the other one's issue.

test('a credential whose name is the prefix of another one does not match its issue', () => {
  const issues = [
    { number: 1, title: 'Rotate AZURE_CLIENT_ID by 2026-11-01', url: 'https://example.invalid/1' }
  ];
  assert.equal(findReminderIssue(issues, 'AZURE_CLIENT_ID')?.number, 1);
  assert.equal(findReminderIssue(issues, 'AZURE_CLIENT_ID_OLD'), undefined);
});

test('a credential whose name is longer than another one does not match its issue', () => {
  const issues = [
    { number: 2, title: 'Rotate AZURE_CLIENT_ID_OLD by 2026-11-01', url: 'https://example.invalid/2' }
  ];
  assert.equal(findReminderIssue(issues, 'AZURE_CLIENT_ID_OLD')?.number, 2);
  assert.equal(findReminderIssue(issues, 'AZURE_CLIENT_ID'), undefined);
});

test('an issue whose title only mentions the credential in passing is not used', () => {
  const issues = [
    { number: 3, title: 'Rotate AZURE_CLIENT_ID_OLD by 2026-11-01', url: 'https://example.invalid/3' },
    { number: 4, title: 'Rotate AZURE_CLIENT_ID', url: 'https://example.invalid/4' }
  ];
  assert.equal(findReminderIssue(issues, 'AZURE_CLIENT_ID'), undefined);
});

test('the match on the title is case sensitive', () => {
  const issues = [{ number: 5, title: 'rotate azure_client_id by 2026-11-01', url: 'https://example.invalid/5' }];
  assert.equal(findReminderIssue(issues, 'AZURE_CLIENT_ID'), undefined);
});

test('the label is created when it is missing', () => {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    return '[]';
  };
  ensureLabel(null, false, exec);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ['label', 'list']);
  assert.deepEqual(calls[1].slice(0, 2), ['label', 'create']);
});

test('a label that appears between the listing and the creation does not fail the run', () => {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    if (args[0] === 'label' && args[1] === 'list') return '[]';
    throw new Error(
      'gh label failed with exit code 1: failed to create label: a label with the name ops/secret-rotation already exists'
    );
  };
  ensureLabel(null, false, exec);
  assert.equal(calls.length, 2);
});

test('a label that cannot be created still fails the run', () => {
  const exec = (args) => {
    if (args[0] === 'label' && args[1] === 'list') return '[]';
    throw new Error('gh label failed with exit code 1: not allowed to create a label');
  };
  assert.throws(() => ensureLabel(null, false, exec), /not allowed/);
});

// The tests below run the script itself in a child process with a fake
// GitHub CLI, so the argument parsing and the dry run are covered by a test
// instead of by an inspection.

/** A rotation calendar with the given rows. */
function calendarWith(rows) {
  return [
    '# Secrets and credentials',
    '',
    '## Rotation calendar',
    '',
    '| Name | Owner | Next rotation due | Notes |',
    '| --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n');
}

const row = (name, owner, due) => `| \`${name}\` | ${owner} | ${due} | |`;

/**
 * A fake GitHub CLI. It answers the questions the runner asks and records
 * every call in a log file. The runner reads the path of the binary from the
 * GH_CLI environment variable.
 */
function writeFakeGh(directory, { labels = [], issues = [], labelExists = false } = {}) {
  const log = path.join(directory, 'gh-calls.log');
  const binary = path.join(directory, 'gh');
  const source = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');

if (args[0] === 'label' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(JSON.parse(process.env.FAKE_GH_LABELS || '[]')));
} else if (args[0] === 'label' && args[1] === 'create') {
  if (process.env.FAKE_GH_LABEL_EXISTS === 'true') {
    process.stderr.write('failed to create label: a label with the name ops/secret-rotation already exists\\n');
    process.exit(1);
  }
  process.stdout.write('created the label\\n');
} else if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(JSON.parse(process.env.FAKE_GH_ISSUES || '[]')));
} else if (args[0] === 'issue' && args[1] === 'comment') {
  process.stdout.write('');
} else if (args[0] === 'issue' && args[1] === 'create') {
  process.stdout.write('https://example.invalid/issues/created\\n');
} else {
  process.stderr.write('fake gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`;
  writeFileSync(binary, source, 'utf8');
  chmodSync(binary, 0o755);
  return {
    binary,
    log,
    env: {
      FAKE_GH_LOG: log,
      FAKE_GH_LABELS: JSON.stringify(labels),
      FAKE_GH_ISSUES: JSON.stringify(issues),
      FAKE_GH_LABEL_EXISTS: labelExists ? 'true' : 'false'
    }
  };
}

/** Run the reminder script with a fake GitHub CLI and report what it did. */
function runReminder({ calendar = '', args = [], fake = {}, env = {} } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'secret-rotation-'));
  const file = path.join(directory, 'SECRETS.md');
  writeFileSync(file, calendar, 'utf8');
  const fakeGh = writeFakeGh(directory, fake);
  const base = { ...process.env, ...fakeGh.env, GH_CLI: fakeGh.binary };
  delete base.DRY_RUN;
  delete base.GH_REPO;
  const result = spawnSync(process.execPath, [scriptPath, '--file', file, ...args], {
    encoding: 'utf8',
    env: { ...base, ...env }
  });
  const calls = existsSync(fakeGh.log)
    ? readFileSync(fakeGh.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

/** The calls the runner made to the issues API. */
function issueCalls(calls, action) {
  return calls.filter((call) => call[0] === 'issue' && call[1] === action);
}

test('two credentials whose names share a prefix each get their own reminder', () => {
  const result = runReminder({
    calendar: calendarWith([
      row('AZURE_CLIENT_ID', 'Alan', '2020-01-01'),
      row('AZURE_CLIENT_ID_OLD', 'Alan', '2020-02-01')
    ]),
    fake: {
      labels: [{ name: 'ops/secret-rotation' }],
      issues: [
        {
          number: 7,
          title: 'Rotate AZURE_CLIENT_ID by 2020-01-01',
          url: 'https://example.invalid/7'
        }
      ]
    }
  });
  assert.equal(result.status, 0);
  const comments = issueCalls(result.calls, 'comment');
  const creates = issueCalls(result.calls, 'create');
  assert.equal(comments.length, 1);
  assert.equal(comments[0][2], '7');
  assert.match(comments[0][4], /\*\*AZURE_CLIENT_ID\*\*/);
  assert.doesNotMatch(comments[0][4], /AZURE_CLIENT_ID_OLD/);
  assert.equal(creates.length, 1);
  assert.equal(creates[0][creates[0].indexOf('--title') + 1], 'Rotate AZURE_CLIENT_ID_OLD by 2020-02-01');
});

test('a credential whose name is the prefix of another one does not borrow its issue', () => {
  const result = runReminder({
    calendar: calendarWith([
      row('AZURE_CLIENT_ID', 'Alan', '2020-01-01'),
      row('AZURE_CLIENT_ID_OLD', 'Alan', '2020-02-01')
    ]),
    fake: {
      labels: [{ name: 'ops/secret-rotation' }],
      issues: [
        {
          number: 9,
          title: 'Rotate AZURE_CLIENT_ID_OLD by 2020-02-01',
          url: 'https://example.invalid/9'
        }
      ]
    }
  });
  assert.equal(result.status, 0);
  const comments = issueCalls(result.calls, 'comment');
  const creates = issueCalls(result.calls, 'create');
  assert.equal(comments.length, 1);
  assert.equal(comments[0][2], '9');
  assert.match(comments[0][4], /\*\*AZURE_CLIENT_ID_OLD\*\*/);
  assert.equal(creates.length, 1);
  assert.equal(creates[0][creates[0].indexOf('--title') + 1], 'Rotate AZURE_CLIENT_ID by 2020-01-01');
});

test('a dry run prints what it would file and files nothing', () => {
  const result = runReminder({
    calendar: calendarWith([row('DRY_PAT', 'Alan', '2020-01-01')]),
    args: ['--dry-run'],
    fake: { labels: [{ name: 'ops/secret-rotation' }], issues: [] }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[dry-run\] would open an issue labeled "ops\/secret-rotation"/);
  assert.equal(issueCalls(result.calls, 'create').length, 0);
  assert.equal(issueCalls(result.calls, 'comment').length, 0);
});

test('a run without the dry run opens the issue', () => {
  const result = runReminder({
    calendar: calendarWith([row('REAL_PAT', 'Alan', '2020-01-01')]),
    fake: { labels: [{ name: 'ops/secret-rotation' }], issues: [] }
  });
  assert.equal(result.status, 0);
  const creates = issueCalls(result.calls, 'create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0][creates[0].indexOf('--title') + 1], 'Rotate REAL_PAT by 2020-01-01');
  assert.doesNotMatch(result.stdout, /\[dry-run\]/);
});

test('the DRY_RUN environment variable has the same effect as the flag', () => {
  const result = runReminder({
    calendar: calendarWith([row('ENV_PAT', 'Alan', '2020-01-01')]),
    env: { DRY_RUN: 'true' },
    fake: { labels: [{ name: 'ops/secret-rotation' }], issues: [] }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[dry-run\] would open an issue/);
  assert.equal(issueCalls(result.calls, 'create').length, 0);
});

test('a label that appears between the listing and the creation does not stop the run', () => {
  const result = runReminder({
    calendar: calendarWith([row('LABEL_PAT', 'Alan', '2020-01-01')]),
    fake: { labels: [], issues: [], labelExists: true }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /the label "ops\/secret-rotation" already exists/);
  assert.equal(issueCalls(result.calls, 'create').length, 1);
});

test('a name that appears twice is reported and no reminder is filed for it', () => {
  const result = runReminder({
    calendar: calendarWith([
      row('TWICE_PAT', 'Alan', '2020-01-01'),
      row('TWICE_PAT', 'Alan', '2020-02-01')
    ]),
    fake: { labels: [{ name: 'ops/secret-rotation' }], issues: [] }
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::warning::/);
  assert.match(result.stdout, /appears more than once/);
  assert.equal(issueCalls(result.calls, 'create').length, 0);
  assert.equal(issueCalls(result.calls, 'comment').length, 0);
});

test('an unknown argument is refused', () => {
  const result = runReminder({ args: ['--nope'] });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument: --nope/);
});

test('a window that is not a number of days is refused', () => {
  const result = runReminder({ args: ['--within-days', '-1'] });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--within-days must be a non-negative integer/);
});

test('the help text says how to run the script', () => {
  const result = runReminder({ args: ['--help'] });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage: node scripts\/secret-rotation-remind\.mjs/);
});

test('the window decides what is due', () => {
  const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const calendar = calendarWith([row('WINDOW_PAT', 'Alan', soon)]);
  const narrow = runReminder({ calendar, args: ['--within-days', '1'], fake: { labels: [], issues: [] } });
  assert.match(narrow.stdout, /nothing is due for rotation/);
  const wide = runReminder({ calendar, args: ['--within-days', '30'], fake: { labels: [], issues: [] } });
  const creates = issueCalls(wide.calls, 'create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0][creates[0].indexOf('--title') + 1], `Rotate WINDOW_PAT by ${soon}`);
});
