import { describe, expect, it } from 'vitest';

import { commentText, distinctFileName, isPlainJsonFileName, singleQuotedText, snippetPlaceholderText } from '../../src/utils/safeText';

describe('safeText', () => {
  it('keeps text inside a comment: no line breaks and no early block-comment end', () => {
    const text = commentText('A */ evil(); /*\nB\r\nC\u2028D\u2029E');
    expect(text).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(text).not.toContain('*/');
  });

  it('escapes quotes, backslashes and line breaks for a single-quoted string', () => {
    expect(singleQuotedText("it's a \\ \n")).toBe("it\\'s a \\\\ \\n");
  });

  it('escapes snippet placeholder syntax', () => {
    const text = snippetPlaceholderText("a}$b'");
    // After VS Code reads the snippet, `\\` becomes `\`, so the code gets a\'.
    expect(text).toBe("a\\}\\$b\\\\'");
  });

  it('keeps layouts whose names differ only by punctuation as different files', () => {
    const names = ['A/B', 'A:B', 'A?B'].map((name) => distinctFileName(name, name.replace(/[^A-Za-z0-9_.-]+/g, '_')));
    expect(new Set(names).size).toBe(3);
  });

  it('keeps spacing variants, underscores and cut-short names apart', () => {
    const clean = (name: string) => name.replace(/\s+/g, '_').slice(0, 120);
    const names = ['My Layout', 'My  Layout', 'My_Layout', 'x'.repeat(130) + 'a', 'x'.repeat(130) + 'b'].map((name) =>
      distinctFileName(name, clean(name))
    );
    expect(new Set(names).size).toBe(5);
  });

  it('accepts only plain json file names from an index', () => {
    expect(isPlainJsonFileName('p__L__2020__id.json')).toBe(true);
    for (const bad of ['../x.json', 'a/b.json', 'a\\b.json', '..json', 'x.txt', 5, undefined]) {
      expect(isPlainJsonFileName(bad)).toBe(false);
    }
  });

  it('leaves plain names alone and avoids Windows device names and dot-only names', () => {
    expect(distinctFileName('Contacts', 'Contacts')).toBe('Contacts');
    expect(distinctFileName('CON', 'CON')).toBe('_CON');
    expect(distinctFileName('nul.txt', 'nul.txt')).toBe('_nul.txt');
    expect(distinctFileName('..', '..')).not.toMatch(/^\.+$/);
    expect(distinctFileName('', '')).toBe('layout');
  });
});
