// Step recorder: every step has an expectation, a result and a screenshot, and ends up in report.md/json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Replace absolute local paths (home, temp, repository) so a committed or attached report names no machine. */
export function scrub(text) {
  let t = String(text ?? '');
  const roots = [
    [process.cwd(), '<cwd>'],
    [os.tmpdir(), '<tmp>'],
    [`/private${os.tmpdir()}`, '<tmp>'],
    [os.homedir(), '~']
  ];
  for (const [from, to] of roots) if (from && from.length > 3) t = t.split(from).join(to);
  return t
    .replace(/\/(?:private\/)?var\/folders\/[^/\s]+\/[^/\s]+\/T/g, '<tmp>')
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~');
}

export class Report {
  constructor(dir) {
    this.dir = dir;
    this.rows = [];
    this.n = 0;
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  }
  nextShot(journey, label) {
    this.n += 1;
    const safe = `${String(this.n).padStart(3, '0')}-${journey}-${label}`
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 90);
    return path.join(this.dir, 'screenshots', `${safe}.png`);
  }
  add(row) {
    this.rows.push(row);
    const mark =
      { PASS: 'PASS', FAIL: 'FAIL', NOTE: 'NOTE', 'NOT-TESTABLE': 'N/T' }[row.result] ?? row.result;
    console.log(
      `[${mark}] ${row.journey} / ${row.step}${row.detail ? `  -- ${String(row.detail).split('\n')[0].slice(0, 160)}` : ''}`
    );
  }
  write() {
    const rows = this.rows.map((r) => ({
      ...r,
      shot: r.shot ? path.relative(this.dir, r.shot) : r.shot,
      detail: scrub(r.detail),
      expect: scrub(r.expect)
    }));
    fs.writeFileSync(path.join(this.dir, 'report.json'), JSON.stringify(rows, null, 2));
    const esc = (s) =>
      String(s ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ')
        .slice(0, 400);
    const lines = ['# E2E UI report', '', `Generated ${new Date().toISOString()}`, ''];
    const counts = {};
    for (const r of this.rows) counts[r.result] = (counts[r.result] ?? 0) + 1;
    lines.push(
      `Totals: ${Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
      ''
    );
    lines.push(
      '| Journey | Step | Expectation | Result | Screenshot | Detail |',
      '|---|---|---|---|---|---|'
    );
    for (const r of this.rows)
      lines.push(
        `| ${esc(r.journey)} | ${esc(r.step)} | ${esc(scrub(r.expect))} | ${r.result} | ${r.shot ? path.relative(this.dir, r.shot) : ''} | ${esc(scrub(r.detail))} |`
      );
    fs.writeFileSync(path.join(this.dir, 'report.md'), `${lines.join('\n')}\n`);
  }
}
