import { mkdtemp, readFile, rm } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { BatchService, parseBatchUpdateInput } from '../../src/services/batchService';
import { createCsvStreamWriter } from '../../src/utils/csvStreamWriter';
import { recordsToCsv } from '../../src/utils/exportCsv';
import { isFormulaNeutralizationOn } from '../../src/utils/userScopeSetting';

const config = (inspected: unknown) => ({ inspect: () => inspected, get: () => undefined }) as never;

describe('filemaker.export.neutralizeFormulas', () => {
  it('is on by default and only the user value can turn it off', () => {
    expect(isFormulaNeutralizationOn(config(undefined))).toBe(true);
    expect(isFormulaNeutralizationOn(config({ defaultValue: true }))).toBe(true);
    expect(isFormulaNeutralizationOn(config({ globalValue: true }))).toBe(true);
    expect(isFormulaNeutralizationOn(config({ globalValue: false }))).toBe(false);
    // A workspace or folder file asking for false is ignored, as is a value that is not a boolean.
    expect(isFormulaNeutralizationOn(config({ workspaceValue: false, workspaceFolderValue: false }))).toBe(true);
    expect(isFormulaNeutralizationOn(config({ globalValue: 'no' }))).toBe(true);
    expect(isFormulaNeutralizationOn({} as never)).toBe(true);
  });

  it('is declared application-scoped and documented in the manifest', () => {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { configuration: Array<{ properties: Record<string, Record<string, unknown>> }> };
    };
    const setting = Object.assign({}, ...manifest.contributes.configuration.map((c) => c.properties))[
      'filemaker.export.neutralizeFormulas'
    ] as Record<string, unknown>;
    expect(setting.scope).toBe('application');
    expect(setting.default).toBe(true);
    expect(String(setting.markdownDescription)).toMatch(/HYPERLINK/);
  });

  it('CSV writers add the apostrophe by default and leave text alone when off', async () => {
    expect(recordsToCsv([{ a: '=1+1' }])).toBe("a\n'=1+1");
    expect(recordsToCsv([{ a: '=1+1' }], { neutralizeFormulas: false })).toBe('a\n=1+1');

    const dir = await mkdtemp(path.join(tmpdir(), 'neutralize-'));
    try {
      for (const [neutralize, expected] of [[undefined, "'=1+1"], [true, "'=1+1"], [false, '=1+1']] as const) {
        const file = path.join(dir, `out-${String(neutralize)}.csv`);
        const writer = await createCsvStreamWriter(file, { neutralizeFormulas: neutralize });
        await writer.append({ a: '=1+1' });
        await writer.close();
        expect((await readFile(file, 'utf8')).split('\n')[1]).toBe(expected);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('batch export follows the setting, and import takes the apostrophe off either way', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'neutralize-batch-'));
    try {
      const run = async (on: boolean) => {
        const findRecords = vi
          .fn()
          .mockResolvedValueOnce({ data: [{ recordId: '1', modId: '1', fieldData: { Name: '=SUM(1)' } }] })
          .mockResolvedValueOnce({ data: [] });
        const service = new BatchService({ findRecords } as never, {
          getPerformanceMode: () => 'standard',
          getNeutralizeFormulas: () => on
        });
        const out = path.join(dir, `batch-${on}.csv`);
        await service.batchExportFind({ id: 'p' } as never, 'L', { query: [{}] }, { outputPath: out, format: 'csv', pageSize: 10, maxRecords: 10 });
        return readFile(out, 'utf8');
      };
      const protectedCsv = await run(true);
      const rawCsv = await run(false);
      expect(protectedCsv).toContain("'=SUM(1)");
      expect(rawCsv).not.toContain("'=SUM(1)");
      expect(rawCsv).toContain('=SUM(1)');
      for (const csv of [protectedCsv, rawCsv]) {
        expect(parseBatchUpdateInput(csv, 'csv')[0]?.fieldData).toEqual({ Name: '=SUM(1)' });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Copy as table skips the apostrophe only when the page was told the setting is off', () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/webviews/queryBuilder/ui/index.js'), 'utf8');
    const body = source.slice(source.indexOf('function buildResultsTsv()'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/state\.neutralizeFormulas === false \? flat : window\.CellText\.neutralizeFormula\(flat\)/);
    expect(source).toContain('state.neutralizeFormulas = payload.neutralizeFormulas !== false;');
  });
});
