import { chmod, mkdir, mkdtemp, readFile, stat, readdir, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AI_CONTEXT_END_MARKER, AI_CONTEXT_START_MARKER, wrapInMarkers } from '../../src/services/aiContextRenderer';
import {
  addToGitignore,
  applyMarkerSection,
  gitignoreLine,
  MarkersMissingError,
  readExistingFile,
  UnsupportedEncodingError,
  writeFileAtomic,
  writeFileIfUnchanged
} from '../../src/services/aiContextWriter';

const section = wrapInMarkers('NEW CONTENT\n');

describe('applyMarkerSection', () => {
  it('creates the file when there is none, or it is empty', () => {
    expect(applyMarkerSection(undefined, section, false)).toEqual({ text: section, mode: 'created' });
    expect(applyMarkerSection('', section, false)).toEqual({ text: section, mode: 'created' });
  });

  it('replaces only the marker section and keeps everything else byte for byte', () => {
    const before = '# My rules\r\n\r\nBe kind.\r\n';
    const after = '\r\n## Other\r\nkeep me\r\n';
    const old = `${AI_CONTEXT_START_MARKER}\nOLD\n${AI_CONTEXT_END_MARKER}\n`;
    const result = applyMarkerSection(`${before}${old}${after}`, section, false);

    expect(result.mode).toBe('replaced');
    // The old section used LF in a CRLF file; the new one follows the file.
    expect(result.text).toBe(`${before}${section.replace(/\n/g, '\r\n')}${after}`);
    expect(result.text).not.toContain('OLD');
  });

  it('keeps CRLF when the existing section uses CRLF, and leaves no bare LF in it', () => {
    const old = `${AI_CONTEXT_START_MARKER}\r\nOLD\r\n${AI_CONTEXT_END_MARKER}\r\n`;
    const result = applyMarkerSection(`# Top\r\n${old}tail\r\n`, section, false);
    expect(result.text).toBe(`# Top\r\n${section.replace(/\n/g, '\r\n')}tail\r\n`);
    expect(result.text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('appends with the file line ending, and leaves an LF file alone', () => {
    expect(applyMarkerSection('# Hi\r\n', section, true).text).toBe(`# Hi\r\n\r\n${section.replace(/\n/g, '\r\n')}`);
    expect(applyMarkerSection('# Hi\n', section, true).text).not.toContain('\r');
  });

  it('replaces a section at the very end of the file without a trailing newline', () => {
    const result = applyMarkerSection(`top\n${AI_CONTEXT_START_MARKER}\nOLD\n${AI_CONTEXT_END_MARKER}`, section, false);
    expect(result.text).toBe(`top\n${section}`);
  });

  it('refuses a file without markers unless appending is allowed, then leaves the content alone', () => {
    expect(() => applyMarkerSection('# Hello\n', section, false)).toThrow(MarkersMissingError);
    const result = applyMarkerSection('# Hello\n', section, true);
    expect(result.mode).toBe('appended');
    expect(result.text).toBe(`# Hello\n\n${section}`);
  });

  it.each([
    ['a lone start marker', `${AI_CONTEXT_START_MARKER}\nx\n`],
    ['a lone end marker', `x\n${AI_CONTEXT_END_MARKER}\n`],
    ['reversed markers', `${AI_CONTEXT_END_MARKER}\n${AI_CONTEXT_START_MARKER}\n`],
    [
      'two sections',
      `${AI_CONTEXT_START_MARKER}\na\n${AI_CONTEXT_END_MARKER}\n${AI_CONTEXT_START_MARKER}\nb\n${AI_CONTEXT_END_MARKER}\n`
    ]
  ])('refuses %s', (_label, existing) => {
    expect(() => applyMarkerSection(existing, section, true)).toThrow(/malformed/);
  });
});

describe('gitignoreLine', () => {
  it('anchors the path and escapes glob and comment characters', () => {
    expect(gitignoreLine('.filemaker/ai-context.md')).toBe('/.filemaker/ai-context.md');
    expect(gitignoreLine('a*b[1]?.md')).toBe('/a\\*b\\[1\\]\\?.md');
    expect(gitignoreLine('#notes.md')).toBe('/\\#notes.md');
    expect(gitignoreLine('trail.md ')).toBe('/trail.md\\ ');
  });
});

describe('file writing', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'fm-ai-writer-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes atomically, creates folders and leaves no temporary file behind', async () => {
    const target = join(dir, 'a', 'b', 'ai.md');
    await writeFileAtomic(target, 'hello');
    expect(await readFile(target, 'utf8')).toBe('hello');
    await writeFileAtomic(target, 'again');
    expect(await readFile(target, 'utf8')).toBe('again');
    expect(await readdir(join(dir, 'a', 'b'))).toEqual(['ai.md']);
  });

  it.skipIf(process.platform === 'win32')('new context exports are owner-only even with a permissive umask', async () => {
    const previous = process.umask(0);
    try {
      const target = join(dir, 'private.md');
      await writeFileAtomic(target, 'private export');
      expect((await stat(target)).mode & 0o7777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it('replaces a link at the target instead of writing through it', async () => {
    const victim = join(dir, 'victim.md');
    await writeFile(victim, 'untouched');
    const target = join(dir, 'ai.md');
    await symlink(victim, target);

    await writeFileAtomic(target, 'generated');

    expect(await readFile(victim, 'utf8')).toBe('untouched');
    expect(await readFile(target, 'utf8')).toBe('generated');
  });

  it('reads a missing file as undefined and refuses a very large one', async () => {
    expect(await readExistingFile(join(dir, 'missing.md'))).toBeUndefined();
    await writeFile(join(dir, 'big.md'), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    await expect(readExistingFile(join(dir, 'big.md'))).rejects.toThrow(/too large/);
  });

  it('refuses a Latin-1 file and leaves its bytes unchanged', async () => {
    const target = join(dir, 'AGENTS.md');
    const bytes = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a]); // "Café\n" in Latin-1
    await writeFile(target, bytes);
    await expect(readExistingFile(target)).rejects.toThrow(UnsupportedEncodingError);
    expect((await readFile(target)).equals(bytes)).toBe(true);
  });

  it.each([
    ['UTF-16 LE BOM', Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00])],
    ['UTF-16 BE BOM', Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x0a])],
    ['UTF-16 without BOM', Buffer.from([0x41, 0x00, 0x42, 0x00])]
  ])('refuses %s and leaves it unchanged', async (_label, bytes) => {
    const target = join(dir, 'x.md');
    await writeFile(target, bytes);
    await expect(readExistingFile(target)).rejects.toThrow(/not valid UTF-8/);
    expect((await readFile(target)).equals(bytes)).toBe(true);
  });

  it('reads valid UTF-8, including accents and a BOM, exactly', async () => {
    const target = join(dir, 'u.md');
    await writeFile(target, '\uFEFFCafé 顧客\n');
    expect(await readExistingFile(target)).toBe('\uFEFFCafé 顧客\n');
  });

  it('writeFileIfUnchanged refuses when the file changed since it was read', async () => {
    const target = join(dir, 'ai.md');
    await writeFile(target, 'one');
    await writeFile(target, 'two');
    await expect(writeFileIfUnchanged(target, 'new', 'one')).rejects.toThrow(/changed while/);
    expect(await readFile(target, 'utf8')).toBe('two');
    await writeFileIfUnchanged(target, 'new', 'two');
    expect(await readFile(target, 'utf8')).toBe('new');
    // A file that appeared after we saw none.
    await expect(writeFileIfUnchanged(target, 'x', undefined)).rejects.toThrow(/changed while/);
  });

  it.skipIf(process.platform === 'win32')('keeps the mode of an existing file', async () => {
    const target = join(dir, 'mode.md');
    await writeFile(target, 'old');
    await chmod(target, 0o600);
    await writeFileAtomic(target, 'new');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('creates .gitignore, adds the line once, and keeps existing lines', async () => {
    expect(await addToGitignore(dir, '.filemaker/ai-context.md')).toBe(true);
    expect(await addToGitignore(dir, '.filemaker/ai-context.md')).toBe(false);
    await writeFile(join(dir, '.gitignore'), 'node_modules\n');
    expect(await addToGitignore(dir, 'AGENTS.md')).toBe(true);
    const text = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(text.startsWith('node_modules\n')).toBe(true);
    expect(text).toContain('\n/AGENTS.md\n');
  });

  it('refuses a .gitignore that is a symbolic link', async () => {
    const victim = join(dir, 'elsewhere');
    await mkdir(victim);
    await writeFile(join(victim, 'target'), 'x');
    await symlink(join(victim, 'target'), join(dir, '.gitignore'));
    await expect(addToGitignore(dir, 'ai.md')).rejects.toThrow(/symbolic link/);
    expect(await readFile(join(victim, 'target'), 'utf8')).toBe('x');
  });
});
