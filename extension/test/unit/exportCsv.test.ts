import { describe, expect, it } from 'vitest';

import { escapeCsvValue, recordsToCsv, restoreFormulaText } from '../../src/utils/exportCsv';

describe('exportCsv', () => {
  it('escapes commas, quotes, and newlines', () => {
    expect(escapeCsvValue('Hello, world')).toBe('"Hello, world"');
    expect(escapeCsvValue('He said "Hi"')).toBe('"He said ""Hi"""');
    expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"');
  });

  it('exports records with header row', () => {
    const csv = recordsToCsv([
      { recordId: '1', Name: 'Ada Lovelace', Note: 'Mathematician' },
      { recordId: '2', Name: 'Grace Hopper', Note: 'Computer scientist' }
    ]);

    const lines = csv.split('\n');
    expect(lines[0]).toContain('recordId');
    expect(lines[1]).toContain('Ada Lovelace');
    expect(lines[2]).toContain('Grace Hopper');
  });
});

describe('exportCsv spreadsheet formulas', () => {
  it('defuses text a spreadsheet would run as a formula', () => {
    expect(escapeCsvValue('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(escapeCsvValue('+cmd|calc')).toBe("'+cmd|calc");
    expect(escapeCsvValue('@SUM(1)')).toBe("'@SUM(1)");
    expect(escapeCsvValue('-2+3')).toBe("'-2+3");
    expect(escapeCsvValue('\tTabbed')).toBe("'\tTabbed");
  });

  it('leaves numbers, ordinary text and header names alone', () => {
    expect(escapeCsvValue(-5)).toBe('-5');
    expect(escapeCsvValue('-5')).toBe('-5');
    expect(escapeCsvValue('-1.5e3')).toBe('-1.5e3');
    expect(escapeCsvValue('Ada')).toBe('Ada');
  });

  it('can be switched off', () => {
    const csv = recordsToCsv([{ A: '=1+1' }], { neutralizeFormulas: false });
    expect(csv.split('\n')[1]).toBe('=1+1');
  });

  it('applies to every cell of an export', () => {
    const csv = recordsToCsv([{ A: '=1+1' }]);
    expect(csv.split('\n')[1]).toBe("'=1+1");
  });
});

describe('exportCsv round trip', () => {
  it('leaves signed numbers and phone numbers alone', () => {
    expect(escapeCsvValue('+1 (555) 123-4567')).toBe('+1 (555) 123-4567');
    expect(escapeCsvValue('-1,234.5')).toBe('"-1,234.5"');
  });

  it('restores text the export defused, and nothing else', () => {
    for (const text of ['=1+1', '@x', '-N/A', '+cmd|calc', '-Notes']) {
      expect(restoreFormulaText(escapeCsvValue(text).replace(/^"|"$/g, ''))).toBe(text);
    }
    expect(restoreFormulaText("it's fine")).toBe("it's fine");
    expect(restoreFormulaText("'plain")).toBe("'plain");
  });
});
