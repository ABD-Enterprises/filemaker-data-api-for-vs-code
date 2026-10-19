import { describe, expect, it } from 'vitest';
import { FIELD_LAYOUT, standardFieldSize } from '@fmweb/shared';

describe('shared field presentation rules', () => {
  it('defines the single grid, spacing and label standard', () => {
    expect(FIELD_LAYOUT).toMatchObject({ grid: 8, pageMargin: 24, rowGap: 16, columnGap: 24, labelPosition: 'top' });
  });
  it.each([
    ['text', 240, 34], ['Text', 240, 34], ['number', 120, 34], ['date', 160, 34],
    ['time', 160, 34], ['timestamp', 160, 34], ['container', 240, 160],
    ['long text', 240, 96], ['unknown', 240, 34], [undefined, 240, 34]
  ])('sizes %s', (type, width, height) => {
    expect(standardFieldSize({ type })).toEqual({ width, height });
  });
  it('sizes multiline and option controls from display metadata', () => {
    expect(standardFieldSize({ multiline: true })).toEqual({ width: 240, height: 96 });
    expect(standardFieldSize({ displayType: 'textarea' }).height).toBe(96);
    for (const displayType of ['checkbox', 'radio']) {
      expect(standardFieldSize({ displayType, optionCount: 4 })).toEqual({ width: 240, height: 96 });
      expect(standardFieldSize({ displayType, optionCount: 0 }).height).toBe(34);
      expect(standardFieldSize({ displayType, optionCount: NaN }).height).toBe(34);
    }
  });
});
