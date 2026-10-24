#!/usr/bin/env node
// Files (or comments on) the secret rotation reminders that the monthly
// `secret-rotation-reminder.yml` workflow sends.
//
// The script reads the "Rotation calendar" table of docs/SECRETS.md with the
// parser in scripts/lib/secret-rotation.mjs and, for every credential that is
// past due or due within the next 30 days, it either comments on the open
// issue that already tracks that credential or opens one.
//
// Safety: the script reads the rotation calendar and nothing else. It never
// prints an environment variable, a token or a credential value, because the
// calendar only ever holds names, owners and dates.
//
// Usage:
//   node scripts/secret-rotation-remind.mjs [--dry-run] [--file <path>]
//        [--repo <owner/name>] [--within-days <days>]
//
// Environment:
//   GH_TOKEN  token used by the GitHub CLI (the workflow passes the job's
//             GITHUB_TOKEN). GH_REPO sets the target repository, GH_CLI the
//             path of the GitHub CLI binary. DRY_RUN=true has the same effect
//             as --dry-run.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRotationCalendar, STATUS } from './lib/secret-rotation.mjs';

const LABEL = 'ops/secret-rotation';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    dryRun: false,
    file: path.join(repoRoot, 'docs', 'SECRETS.md'),
    repo: null,
    withinDays: 30
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--file') options.file = path.resolve(argv[++index]);
    else if (arg === '--repo') options.repo = argv[++index];
    else if (arg === '--within-days') options.withinDays = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/secret-rotation-remind.mjs [--dry-run] [--file <path>] [--repo <owner/name>] [--within-days <days>]'
      );
      process.exit(0);
    } else {
      console.error(`secret-rotation-remind: unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (process.env.DRY_RUN && ['true', '1', 'yes', 'on'].includes(process.env.DRY_RUN.toLowerCase())) {
    options.dryRun = true;
  }
  if (!Number.isInteger(options.withinDays) || options.withinDays < 0) {
    console.error('secret-rotation-remind: --within-days must be a non-negative integer');
    process.exit(2);
  }
  return options;
}

function repoArgs(repo) {
  return repo ? ['--repo', repo] : [];
}

/**
 * The outcome of a GitHub CLI call: the exit status of the command and its
 * trimmed output. A non-zero exit is part of the outcome and not an
 * exception, so the caller can tell one failure from another.
 *
 * @typedef {{ status: number, stdout: string, stderr: string }} GhResult
 */

/** The message of a failed GitHub CLI call. */
function ghFailure(args, status, detail) {
  return `gh ${args[0]} failed with exit code ${status}${detail ? `: ${detail}` : ''}`;
}

/**
 * Run the GitHub CLI and return its outcome. Throws only when the CLI cannot
 * be started at all.
 *
 * @param {string[]} args the arguments of the command
 * @returns {GhResult}
 */
function gh(args) {
  const binary = process.env.GH_CLI || 'gh';
  const result = spawnSync(binary, args, { encoding: 'utf8' });
  if (result.error) {
    const reason =
      result.error.code === 'ENOENT'
        ? `the GitHub CLI (${binary}) is not on the PATH`
        : result.error.message;
    throw new Error(`gh ${args[0]} failed: ${reason}`);
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  };
}

/**
 * Run the GitHub CLI and return its trimmed stdout. Throws on a failure.
 */
function ghText(args) {
  const result = gh(args);
  if (result.status !== 0) {
    throw new Error(ghFailure(args, result.status, result.stderr || result.stdout));
  }
  return result.stdout;
}

/**
 * Run the GitHub CLI and return the JSON it printed. Throws on a failure.
 *
 * The exit code and the error output of the command are captured, so a
 * caller that has to tell one API failure from another can look at them.
 * The `exec` argument is the seam the tests use: it takes the argument list
 * and returns the outcome of the command.
 *
 * @param {string[]} args the arguments of the command
 * @param {(args: string[]) => GhResult} [exec] the seam the tests use
 */
export function ghJson(args, exec = gh) {
  const { status, stdout, stderr } = exec(args);
  if (status !== 0) {
    const error = new Error(ghFailure(args, status, stderr || stdout));
    error.status = status;
    error.stderr = stderr;
    throw error;
  }
  try {
    return JSON.parse(stdout || '[]');
  } catch {
    throw new Error(`gh ${args[0]} did not return JSON`);
  }
}

/** The HTTP status of a GitHub CLI error message, or null when it has none. */
function httpStatus(stderr) {
  const match = /HTTP (\d{3})\b/.exec(stderr || '');
  return match ? Number(match[1]) : null;
}

/**
 * True when a failed label creation means the label is already there.
 *
 * The GitHub CLI reports an API error as `HTTP <status>: <message> (<url>)`.
 * Creating a label that exists answers `HTTP 422: Validation Failed`, so the
 * status says the label is there even when the message never names it. The
 * wording is matched as well, for a CLI that words the same failure
 * differently.
 *
 * @param {GhResult} result the outcome of the label creation
 */
export function isLabelAlreadyThere(result) {
  if (result.status === 0) return false;
  if (httpStatus(result.stderr) === 422) return true;
  return /already exists/i.test(result.stderr || '');
}

/** The label the reminder issues carry. It is created when it is missing. */
export function ensureLabel(repo, dryRun, exec = gh) {
  const labels = ghJson(['label', 'list', '--limit', '200', '--json', 'name', ...repoArgs(repo)], exec);
  if (labels.some((label) => label.name === LABEL)) return;
  if (dryRun) {
    console.log(`[dry-run] would create the missing label "${LABEL}"`);
    return;
  }
  const args = [
    'label',
    'create',
    LABEL,
    '--color',
    '0e8a16',
    '--description',
    'Reminder to rotate a tracked credential',
    ...repoArgs(repo)
  ];
  const result = exec(args);
  if (result.status === 0) {
    console.log(`created the missing label "${LABEL}"`);
    return;
  }
  // The label was created between the listing and the creation (a second
  // run, or a label that appeared by hand). That is the state the runner
  // wanted, so the run carries on instead of failing.
  if (isLabelAlreadyThere(result)) {
    console.log(`the label "${LABEL}" already exists`);
    return;
  }
  throw new Error(ghFailure(args, result.status, result.stderr || result.stdout));
}

/** Open reminder issues that already track a credential. */
export function openReminderIssues(repo, exec = gh) {
  return ghJson(
    [
      'issue',
      'list',
      '--label',
      LABEL,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,url',
      ...repoArgs(repo)
    ],
    exec
  );
}

function dueText(row) {
  if (row.status === STATUS.PAST_DUE) {
    const days = Math.abs(row.daysUntil);
    return `${row.dueDate} (${days} day${days === 1 ? '' : 's'} overdue)`;
  }
  const days = row.daysUntil;
  return `${row.dueDate} (in ${days} day${days === 1 ? '' : 's'})`;
}

/** The title of the issue that tracks a credential. */
export function issueTitle(row) {
  return `Rotate ${row.name} by ${row.dueDate}`;
}

/**
 * The open reminder issue that already tracks a credential, or undefined.
 *
 * The match is anchored on the title the runner itself writes, `Rotate <name>
 * by <YYYY-MM-DD>`, and it is case sensitive: the names in the calendar are
 * exact. A substring match would let `AZURE_CLIENT_ID_OLD` match the issue of
 * `AZURE_CLIENT_ID`, and the reminder would land on the wrong credential.
 */
export function findReminderIssue(issues, name) {
  const prefix = `Rotate ${name} by `;
  return issues.find((issue) => typeof issue.title === 'string' && issue.title.startsWith(prefix));
}

/** The body of a new reminder issue. */
export function issueBody(row) {
  const lines = [
    `Rotation reminder for **${row.name}**.`,
    '',
    `- Owner: ${row.owner || '_not recorded_'}`,
    `- Next rotation due: ${dueText(row)}`,
    '- Source: docs/SECRETS.md, "Rotation calendar"',
    ''
  ];
  if (row.notes) lines.push(`Notes: ${row.notes}`, '');
  lines.push(
    'Checklist:',
    '',
    '- [ ] Confirm the credential is still in use and still has to be stored',
    '- [ ] Rotate it at the source (the rotation steps are documented in docs/SECRETS.md)',
    '- [ ] Update the stored value, scoped to an environment with a required reviewer',
    '- [ ] Set the next rotation date in the rotation calendar of docs/SECRETS.md',
    '- [ ] Close this issue when the rotation is done'
  );
  return lines.join('\n');
}

/** The body of a comment on an existing reminder issue. */
export function commentBody(row) {
  const lines = [
    `Rotation reminder: **${row.name}** is due ${dueText(row)}.`,
    '',
    `- Owner: ${row.owner || '_not recorded_'}`,
    '- Source: docs/SECRETS.md, "Rotation calendar"',
    ''
  ];
  if (row.notes) lines.push(`Notes: ${row.notes}`, '');
  lines.push(
    'Rotate it at the source, update the stored value, then set the next rotation date in the rotation calendar.'
  );
  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let markdown;
  try {
    markdown = readFileSync(options.file, 'utf8');
  } catch (error) {
    console.error(`secret-rotation-remind: cannot read ${options.file}: ${error.message}`);
    process.exit(1);
  }

  const calendar = parseRotationCalendar(markdown, { withinDays: options.withinDays });
  console.log(`rotation calendar: ${options.file}`);
  if (!calendar.sectionFound) {
    console.log('no "Rotation calendar" section found, so nothing is tracked');
  } else {
    console.log(
      `tracked rows: ${calendar.rows.length} (past due ${calendar.pastDue.length}, due within ${calendar.withinDays} days ${calendar.dueSoon.length}, later ${calendar.ok.length}, no date ${calendar.notTracked.length})`
    );
  }
  for (const row of calendar.ok) {
    console.log(`  ok            ${row.name} (${row.dueDate}, in ${row.daysUntil} days)`);
  }
  for (const row of calendar.notTracked) {
    console.log(`  no date       ${row.name}`);
  }
  for (const skipped of calendar.skipped) {
    console.log(`::warning::docs/SECRETS.md line ${skipped.line}: ${skipped.reason}`);
  }

  const due = [...calendar.pastDue, ...calendar.dueSoon];
  if (due.length === 0) console.log('nothing is due for rotation');

  const repo = options.repo ?? process.env.GH_REPO ?? null;
  let issues = [];
  if (due.length > 0) {
    try {
      ensureLabel(repo, options.dryRun);
      issues = openReminderIssues(repo);
    } catch (error) {
      if (!options.dryRun) {
        console.error(`secret-rotation-remind: ${error.message}`);
        process.exit(1);
      }
      console.log(
        `::warning::could not read the open "${LABEL}" issues (${error.message}); the dry run assumes a new issue would be opened`
      );
    }
  }

  for (const row of due) {
    const existing = findReminderIssue(issues, row.name);
    if (existing) {
      const body = commentBody(row);
      if (options.dryRun) {
        console.log(`[dry-run] would comment on issue #${existing.number} (${existing.title}):`);
        console.log(body);
      } else {
        ghText(['issue', 'comment', String(existing.number), '--body', body, ...repoArgs(repo)]);
        console.log(`commented on issue #${existing.number} for ${row.name}`);
      }
      continue;
    }
    const title = issueTitle(row);
    const body = issueBody(row);
    if (options.dryRun) {
      console.log(`[dry-run] would open an issue labeled "${LABEL}" titled "${title}":`);
      console.log(body);
    } else {
      const url = ghText([
        'issue',
        'create',
        '--title',
        title,
        '--label',
        LABEL,
        '--body',
        body,
        ...repoArgs(repo)
      ]);
      console.log(`opened an issue for ${row.name}: ${url}`);
    }
  }

  if (calendar.skipped.length > 0) {
    console.error(
      `secret-rotation-remind: ${calendar.skipped.length} rotation calendar row(s) could not be read; fix them in docs/SECRETS.md`
    );
    process.exit(1);
  }
}

// The script runs when it is called directly; importing it (a test) only
// exposes the helpers above.
const calledDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (calledDirectly) main();
