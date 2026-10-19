import { describe, expect, it } from 'vitest';

import {
  MAX_RENDER_CHARS,
  capOutput,
  fence,
  renderDescribe,
  renderLayouts,
  renderRecords,
  safeLine
} from '../../../../src/ai/chat/chatText';
import { assertSafeMarkdown } from './chatHarness';

const HOSTILE = [
  '[click](command:workbench.action.reloadWindow)',
  '![x](https://evil.example/p.png)',
  '<img src=x onerror=alert(1)>',
  '<a href="command:workbench.action.terminal.new">x</a>',
  '```\n# Heading\n[a](command:x)',
  '`````',
  '```text',
  'line\r\nbreak\u2028sep \u202e reversed \u200b zero \u0000 nul',
  '~~~\n[b](command:y)\n~~~',
  'javascript:alert(1) data:text/html,<b>',
  'x'.repeat(5000)
];

describe('safeLine', () => {
  it('writes control, format and separator characters as escapes and caps the length', () => {
    const line = safeLine('a\nb\r\u0000\u202e\u2028\u200bz');
    expect(line).toBe('a\\u000ab\\u000d\\u0000\\u202e\\u2028\\u200bz');
    expect(safeLine('x'.repeat(300), 10)).toBe('xxxxxxxxxx... (+290 more characters)');
    expect(safeLine(undefined)).toBe('');
  });
});

describe('fence', () => {
  it('is longer than any run of backticks in the text, so the text cannot close it', () => {
    for (const run of [0, 1, 2, 3, 4, 7, 12]) {
      const lines = [`a${'`'.repeat(run)}b`, '`'.repeat(run)];
      const block = fence(lines);
      const marks = /^(`+)text\n/.exec(block)?.[1] as string;
      expect(marks.length).toBeGreaterThanOrEqual(3);
      expect(marks.length).toBeGreaterThan(run);
      expect(block.endsWith(`\n${marks}`)).toBe(true);
      assertSafeMarkdown(block);
    }
  });
});

describe('capOutput', () => {
  it('cuts long output and never leaves a fence open', () => {
    const block = fence(
      Array.from({ length: 2000 }, (_, index) => `line ${index} ${'z'.repeat(20)}`)
    );
    const capped = capOutput(block);
    expect(capped.length).toBeLessThan(MAX_RENDER_CHARS + 200);
    assertSafeMarkdown(capped);
    expect(capped).toContain('The output was cut');
  });
});

describe('renderers with hostile data', () => {
  it('layout names, field names and record values never leave their fence', () => {
    const layouts = renderLayouts({
      layouts: HOSTILE.map((name) => ({ name, usable: true })),
      count: HOSTILE.length
    });
    const described = renderDescribe({
      layout: HOSTILE[0],
      fields: HOSTILE.map((name) => ({ name, type: HOSTILE[1] }))
    });
    const records = renderRecords({
      foundCount: 2,
      records: [
        {
          recordId: HOSTILE[0],
          fields: Object.fromEntries(HOSTILE.map((value, index) => [HOSTILE[index], value]))
        }
      ],
      portals: undefined,
      quota: { used: 1, limit: 500 }
    });
    for (const text of [layouts, described, records]) {
      assertSafeMarkdown(text, ['evil.example', 'workbench.action', 'onerror']);
    }
  });

  it('shows at most 20 records and cuts the output', () => {
    const records = Array.from({ length: 50 }, (_, index) => ({
      recordId: String(index),
      fields: { A: 'v'.repeat(5000) }
    }));
    const text = renderRecords({ records, foundCount: 50, truncated: true });
    expect((text.match(/record id:/g) ?? []).length).toBe(20);
    expect(text).toContain('cut by the tool limits');
    expect(text).not.toContain('v'.repeat(300));
  });

  it('survives results of the wrong shape', () => {
    for (const value of [undefined, null, 'x', 5, [], { layouts: 'no', records: 7, fields: {} }]) {
      expect(() => {
        renderLayouts(value);
        renderDescribe(value);
        renderRecords(value);
      }).not.toThrow();
    }
  });
});
