// Tests for the reminder runner in scripts/secret-rotation-remind.mjs.
// Run with: node --test scripts/
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commentBody, findReminderIssue, issueBody, issueTitle } from './secret-rotation-remind.mjs';

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
