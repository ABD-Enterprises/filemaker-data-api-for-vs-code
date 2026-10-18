import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog, formatAuditLine } from '../../../src/ai/aiAudit';

describe('formatAuditLine', () => {
  const at = new Date('2026-10-18T12:00:00.000Z');

  it('writes one JSON line and escapes model-supplied text so it cannot add lines or fields', () => {
    const line = formatAuditLine(
      {
        tool: 'fm_edit_record',
        connection: 'Dev',
        layout: 'L"}\n{"outcome":"ok"',
        recordIds: ['1\n2'],
        outcome: 'refused',
        confirmed: false,
        note: 'x\u2028y‮z'
      },
      at
    );
    expect(line).not.toMatch(/[\n\r\u2028‮]/);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.outcome).toBe('refused');
    expect(Object.keys(parsed).sort()).toEqual(['at', 'confirmed', 'connection', 'layout', 'note', 'outcome', 'recordIds', 'tool']);
    expect(String(parsed.layout)).toContain('\\n');
  });

  it('caps a very long line', () => {
    const line = formatAuditLine({ tool: 't', connection: 'c', outcome: 'ok', confirmed: null, recordIds: Array.from({ length: 500 }, () => '1'.repeat(30)) }, at);
    expect(line.length).toBeLessThanOrEqual(2001);
  });
});

describe('AuditLog', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fm-ai-audit-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends lines to a file outside the workspace and reads them back', async () => {
    const log = new AuditLog(join(dir, 'sub', 'audit.log'), () => new Date('2026-01-01T00:00:00Z'));
    await log.record({ tool: 'a', connection: 'c', outcome: 'ok', confirmed: null });
    await log.record({ tool: 'b', connection: 'c', outcome: 'declined', confirmed: false });
    const lines = (await log.read()).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).tool)).toEqual(['a', 'b']);
  });

  it.skipIf(process.platform === 'win32')('creates the file owner-only', async () => {
    const path = join(dir, 'audit.log');
    await new AuditLog(path).record({ tool: 'a', connection: 'c', outcome: 'ok', confirmed: null });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('stays under its size cap by dropping the oldest lines', async () => {
    const path = join(dir, 'audit.log');
    const log = new AuditLog(path, () => new Date(), 4000);
    for (let index = 0; index < 100; index += 1) {
      await log.record({ tool: `tool_${index}`, connection: 'c', outcome: 'ok', confirmed: null, note: 'n'.repeat(50) });
    }
    const size = (await stat(path)).size;
    expect(size).toBeLessThanOrEqual(4000);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('tool_99');
    expect(text).not.toContain('"tool_0"');
  });

  it('never throws when the folder cannot be written', async () => {
    const log = new AuditLog(join('/dev/null', 'x', 'audit.log'));
    await expect(log.record({ tool: 'a', connection: 'c', outcome: 'ok', confirmed: null })).resolves.toBeUndefined();
    expect(await log.read()).toBe('');
  });
});
