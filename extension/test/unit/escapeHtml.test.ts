import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../../src/utils/escapeHtml';

describe('escapeHtml', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
    ['&<>"\'', '&amp;&lt;&gt;&quot;&#39;'],
    ['&amp;', '&amp;amp;'],
    [' plain é ', ' plain é '],
    ['', '']
  ])('escapes %j to %j', (value, expected) => {
    expect(escapeHtml(value)).toBe(expected);
  });

  it('keeps the restore page apostrophe behavior while escaping the other characters', () => {
    expect(escapeHtml('&<>"\'', false)).toBe('&amp;&lt;&gt;&quot;\'');
  });

  it.each([[undefined, 'undefined'], [null, 'null'], [42, '42']] as const)('keeps environment comparison string coercion for %j', (value, expected) => {
    expect(escapeHtml(value)).toBe(expected);
  });
});
