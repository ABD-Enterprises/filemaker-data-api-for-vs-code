// Rotation calendar parser for docs/SECRETS.md.
//
// The monthly `secret-rotation-reminder.yml` workflow reads the "Rotation
// calendar" table of docs/SECRETS.md and files a reminder issue about 30 days
// before each tracked credential is due for rotation.
//
// The parser is dependency-free and read-only. It only ever looks at the
// Markdown text it is handed: it reads no environment variable, no credential
// and no file other than the one the caller names.
//
// Documented behaviour
// - A missing "## Rotation calendar" section means "nothing is tracked": the
//   result is empty, `sectionFound` is false and no error is raised.
// - Rows whose first cell is an HTML comment are comment rows (the table
//   ships with one) and are ignored.
// - A row with the wrong number of cells, or a "Next rotation due" cell that
//   is not a date, is skipped and reported in `skipped` with a reason. A
//   skipped row never turns into a reminder, so a typo cannot silently hide a
//   rotation, and it is never silently dropped either: the caller is told.
//   With `strict: true` the parser throws `SecretRotationParseError` instead.
// - A blank, "N/A" or "-" date means "no rotation date recorded": the row is
//   reported as `not-tracked` and produces no reminder.
// - A name that appears twice in the table is a duplicate: the two rows carry
//   two due dates for one credential, so neither is honored. Every row with
//   that name is skipped and reported, because a reminder for the wrong date
//   is worse than no reminder. The check runs on the raw rows, before the
//   per-row checks, so a name that is written twice is a duplicate even when
//   one of the two rows is unreadable.
// - Dates are ISO `YYYY-MM-DD` only, compared in UTC, so the result does not
//   depend on the runner's time zone.

import { readFileSync } from 'node:fs';

export const ROTATION_SECTION = 'Rotation calendar';
export const DEFAULT_WITHIN_DAYS = 30;

/** Status of a tracked row. */
export const STATUS = {
  PAST_DUE: 'past-due',
  DUE_SOON: 'due-soon',
  OK: 'ok',
  NOT_TRACKED: 'not-tracked'
};

/** Thrown by `parseRotationCalendar` when `strict` is set and a row is unusable. */
export class SecretRotationParseError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'SecretRotationParseError';
    this.details = details;
  }
}

const SECTION_HEADING = /^#{1,3}\s+rotation calendar\s*$/i;
const SECTION_END = /^##\s+/;
const DATE_CELL = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY_DATES = new Set(['', 'n/a', 'na', 'none', '-', '--', '—', 'tbd', 'unknown']);

/** Normalize a table cell for header matching: lower case, no markdown decoration. */
function normalizeHeader(cell) {
  return cell
    .replace(/`/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Strip markdown decoration from a value that is shown to a human. */
function plainText(cell) {
  return cell.replace(/`/g, '').replace(/\*\*/g, '').trim();
}

/**
 * Split a Markdown table row into its cells. Returns null when the line is
 * not a table row. Escaped pipes (`\|`) stay inside the cell.
 */
export function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  let body = trimmed;
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  if (body.startsWith('|')) body = body.slice(1);
  const cells = [];
  let current = '';
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      current += char === '|' ? '|' : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/** True when every cell of the row is a table separator such as `---` or `:---:`. */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

/**
 * Parse an ISO `YYYY-MM-DD` date into a UTC timestamp.
 * Returns null when the text is not an ISO date or not a real calendar date.
 */
export function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!DATE_CELL.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const stamp = Date.UTC(year, month - 1, day);
  const check = new Date(stamp);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return stamp;
}

/** UTC midnight timestamp of the day `value` falls on. */
function utcDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new SecretRotationParseError(`unusable reference date: ${String(value)}`);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Locate the "Rotation calendar" section and return its lines with their line numbers. */
function findSection(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => SECTION_HEADING.test(line.trim()));
  if (start < 0) return { found: false, lines: [] };
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (SECTION_END.test(lines[index])) break;
    collected.push({ text: lines[index], line: index + 1 });
  }
  return { found: true, lines: collected };
}

/** Locate the rotation table inside the section and return its header cells and rows. */
function findTable(sectionLines) {
  const blocks = [];
  let current = null;
  for (const entry of sectionLines) {
    const cells = splitTableRow(entry.text);
    if (!cells) {
      current = null;
      continue;
    }
    if (!current) {
      current = { header: cells, headerLine: entry.line, rows: [] };
      blocks.push(current);
      continue;
    }
    current.rows.push({ cells, line: entry.line });
  }
  for (const block of blocks) {
    const normalized = block.header.map(normalizeHeader);
    if (normalized.includes('next rotation due')) return block;
  }
  return null;
}

/**
 * The name of a raw table row, or an empty string when the row carries no
 * credential: a comment row and a row without a name name nothing.
 *
 * The name column wins over the first cell, but a row that is too short to
 * reach the name column falls back to its first cell, so a row that cannot
 * be read still takes part in the duplicate check.
 */
function rawRowName(cells, nameIndex) {
  const cell = (nameIndex >= 0 ? cells[nameIndex] : undefined) ?? cells[0];
  const name = plainText(cell ?? '');
  if (!name || name.startsWith('<!--')) return '';
  return name;
}

/**
 * The names that appear more than once among the given raw rows, with the
 * line numbers of every row that carries the name.
 *
 * Two rows with the same name carry two due dates for one credential. The
 * check runs on the raw rows, before the per-row checks, so a name that is
 * written twice is a duplicate even when one of the two rows cannot be
 * read: a reminder for the wrong date is worse than no reminder.
 */
function duplicateNames(rows) {
  const lines = new Map();
  for (const entry of rows) {
    lines.set(entry.name, [...(lines.get(entry.name) ?? []), entry.line]);
  }
  const names = new Set();
  for (const [name, rowLines] of lines) {
    if (rowLines.length > 1) names.add(name);
  }
  return { names, lines };
}

/**
 * Parse the rotation calendar out of a Markdown document.
 *
 * @param {string} markdown content of docs/SECRETS.md
 * @param {{ now?: Date | string, withinDays?: number, strict?: boolean }} [options]
 * @returns {{
 *   sectionFound: boolean,
 *   withinDays: number,
 *   rows: object[],
 *   pastDue: object[],
 *   dueSoon: object[],
 *   ok: object[],
 *   notTracked: object[],
 *   skipped: { name: string, line: number, reason: string }[]
 * }}
 */
export function parseRotationCalendar(markdown, options = {}) {
  if (typeof markdown !== 'string') {
    throw new SecretRotationParseError('the rotation calendar must be parsed from a string');
  }
  const withinDays = options.withinDays ?? DEFAULT_WITHIN_DAYS;
  if (!Number.isInteger(withinDays) || withinDays < 0) {
    throw new SecretRotationParseError(`withinDays must be a non-negative integer, got ${String(options.withinDays)}`);
  }
  const strict = options.strict === true;
  const today = utcDay(options.now ?? new Date());
  const day = 24 * 60 * 60 * 1000;

  const result = {
    sectionFound: false,
    withinDays,
    rows: [],
    pastDue: [],
    dueSoon: [],
    ok: [],
    notTracked: [],
    skipped: []
  };

  const section = findSection(markdown);
  result.sectionFound = section.found;
  if (!section.found) return result;

  const table = findTable(section.lines);
  if (!table) {
    result.skipped.push({
      name: '',
      line: section.lines[0]?.line ?? 0,
      reason: `the "${ROTATION_SECTION}" section has no rotation table with a "Next rotation due" column`
    });
    if (strict) {
      throw new SecretRotationParseError(`the "${ROTATION_SECTION}" section has no rotation table`, result.skipped);
    }
    return result;
  }

  const header = table.header.map(normalizeHeader);
  const indexOf = (name) => header.indexOf(name);
  const nameIndex = indexOf('name');
  const ownerIndex = indexOf('owner');
  const dueIndex = indexOf('next rotation due');
  const notesIndex = indexOf('notes');
  const columnCount = table.header.length;

  // The names are collected from the raw rows, before the per-row checks:
  // a name that is written twice is a duplicate even when one of the two
  // rows cannot be read.
  const duplicated = duplicateNames(
    table.rows
      .filter((row) => !isSeparatorRow(row.cells))
      .map((row) => ({ name: rawRowName(row.cells, nameIndex), line: row.line }))
      .filter((entry) => entry.name !== '')
  );

  for (const row of table.rows) {
    if (isSeparatorRow(row.cells)) continue;
    const name = rawRowName(row.cells, nameIndex);
    // A name that appears twice is a duplicate row: the table then holds two
    // due dates for one credential and neither of them can be honored. Both
    // rows are dropped and reported, so the caller warns and fails the run
    // instead of reminding about a date that may be the wrong one. The check
    // comes before the per-row checks, so an unreadable row cannot save the
    // other row of the pair.
    if (name && duplicated.names.has(name)) {
      const reason =
        `the name "${name}" appears more than once in the rotation calendar ` +
        `(lines ${duplicated.lines.get(name).join(', ')}), so no due date can be honored`;
      result.skipped.push({ name, line: row.line, reason });
      continue;
    }
    if (row.cells.length !== columnCount) {
      const reason = `the row has ${row.cells.length} cells, the table header has ${columnCount}`;
      result.skipped.push({ name: plainText(row.cells[0] ?? ''), line: row.line, reason });
      continue;
    }
    const nameCell = row.cells[nameIndex] ?? '';
    if (nameCell.trim().startsWith('<!--')) continue;
    if (!name) {
      result.skipped.push({ name: '', line: row.line, reason: 'the row has no name' });
      continue;
    }
    const rawDue = (row.cells[dueIndex] ?? '').trim();
    const dueText = plainText(rawDue);
    const owner = plainText(row.cells[ownerIndex] ?? '');
    const notes = plainText(row.cells[notesIndex] ?? '');

    if (EMPTY_DATES.has(dueText.toLowerCase())) {
      const entry = {
        name,
        owner,
        notes,
        dueDate: null,
        status: STATUS.NOT_TRACKED,
        daysUntil: null,
        line: row.line
      };
      result.rows.push(entry);
      result.notTracked.push(entry);
      continue;
    }

    const dueStamp = parseIsoDate(dueText);
    if (dueStamp === null) {
      const reason = `"Next rotation due" is not an ISO date (YYYY-MM-DD): "${dueText}"`;
      result.skipped.push({ name, line: row.line, reason });
      continue;
    }

    const daysUntil = Math.round((dueStamp - today) / day);
    const status =
      daysUntil < 0 ? STATUS.PAST_DUE : daysUntil <= withinDays ? STATUS.DUE_SOON : STATUS.OK;
    const entry = {
      name,
      owner,
      notes,
      dueDate: dueText,
      status,
      daysUntil,
      line: row.line
    };
    result.rows.push(entry);
    if (status === STATUS.PAST_DUE) result.pastDue.push(entry);
    else if (status === STATUS.DUE_SOON) result.dueSoon.push(entry);
    else result.ok.push(entry);
  }

  if (strict && result.skipped.length > 0) {
    const details = result.skipped.map((entry) => `line ${entry.line}: ${entry.reason}`).join('; ');
    throw new SecretRotationParseError(`the rotation calendar has ${result.skipped.length} unusable row(s): ${details}`, result.skipped);
  }
  return result;
}

/** Read a Markdown file and parse its rotation calendar. */
export function readRotationCalendar(file, options = {}) {
  return parseRotationCalendar(readFileSync(file, 'utf8'), options);
}
