import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { escapeCsvValue, neutralizeFormula } from '../../src/utils/exportCsv';

const CellText = createRequire(import.meta.url)('../../src/webviews/queryBuilder/ui/cellText.js') as {
  neutralizeFormula(text: string): string;
};

const corpus = [
  '=HYPERLINK("http://evil.example","x")',
  '+cmd|\' /C calc\'!A0',
  '-2+3',
  '@SUM(1+1)',
  '\t=1+1',
  '\r=1+1',
  "'=already quoted",
  "''=twice quoted",
  '5',
  '-5',
  '+5',
  '-1,234.5',
  '+1 (555) 123-4567',
  '1e5',
  '.5',
  'plain text',
  'a=b',
  '',
  ' =leading space'
];

describe('Query Builder copy-as-table formula protection', () => {
  it('behaves exactly like the CSV export helper', () => {
    for (const text of corpus) {
      expect(CellText.neutralizeFormula(text), JSON.stringify(text)).toBe(neutralizeFormula(text));
    }
  });

  it('prefixes formula-looking text and leaves numbers alone', () => {
    expect(CellText.neutralizeFormula('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
    expect(CellText.neutralizeFormula('@SUM(1)')).toBe("'@SUM(1)");
    expect(CellText.neutralizeFormula('-5')).toBe('-5');
    expect(CellText.neutralizeFormula('+1 (555) 123-4567')).toBe('+1 (555) 123-4567');
    // And the CSV export agrees on what a cell with a formula looks like.
    expect(escapeCsvValue('=1+1')).toBe("'=1+1");
  });

  it('is applied to every cell of the copied table', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../src/webviews/queryBuilder/ui/index.js'),
      'utf8'
    );
    const start = source.indexOf('function buildResultsTsv()');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('window.CellText.neutralizeFormula(');
    // header cells and data cells both go through the same cleaner
    expect(body).toMatch(/columns\.map\(clean\)/);
    expect(body).toMatch(/clean\(getCellRaw\(record, column\)\)/);
  });
});
