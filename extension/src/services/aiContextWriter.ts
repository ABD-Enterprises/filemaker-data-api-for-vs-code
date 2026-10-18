import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { AI_CONTEXT_END_MARKER, AI_CONTEXT_START_MARKER } from './aiContextRenderer';
import { resolveConfinedFile } from '../utils/pathConfinement';

const MAX_EXISTING_FILE_BYTES = 5 * 1024 * 1024;

export type SectionWriteMode = 'created' | 'replaced' | 'appended';

export class MarkersMissingError extends Error {
  public constructor() {
    super('The file exists but has no filemaker-ai-context section.');
    this.name = 'MarkersMissingError';
  }
}

/**
 * Puts `wrapped` (content already between the start and end markers) into `existing`:
 *  - no file, or an empty file: the new text is the file;
 *  - one well-formed marker pair: only that section is replaced, the rest is kept byte for byte;
 *  - no markers: throws MarkersMissingError unless `allowAppend`, which adds the section at the end;
 *  - anything else (a lone marker, two sections, reversed markers): refused, nothing guessed.
 */
export function applyMarkerSection(
  existing: string | undefined,
  wrapped: string,
  allowAppend: boolean
): { text: string; mode: SectionWriteMode } {
  if (existing === undefined || existing.length === 0) {
    return { text: wrapped, mode: 'created' };
  }

  const starts = countOccurrences(existing, AI_CONTEXT_START_MARKER);
  const ends = countOccurrences(existing, AI_CONTEXT_END_MARKER);
  if (starts === 0 && ends === 0) {
    if (!allowAppend) {
      throw new MarkersMissingError();
    }
    const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return { text: `${existing}${separator}${wrapped}`, mode: 'appended' };
  }

  const startIndex = existing.indexOf(AI_CONTEXT_START_MARKER);
  const endIndex = existing.indexOf(AI_CONTEXT_END_MARKER);
  if (starts !== 1 || ends !== 1 || endIndex < startIndex) {
    throw new Error(
      'The file has a malformed filemaker-ai-context section (a missing, repeated or reversed marker). Fix or remove the markers and run the command again.'
    );
  }

  let tailStart = endIndex + AI_CONTEXT_END_MARKER.length;
  if (existing[tailStart] === '\r' && existing[tailStart + 1] === '\n') {
    tailStart += 2;
  } else if (existing[tailStart] === '\n') {
    tailStart += 1;
  }

  return {
    text: `${existing.slice(0, startIndex)}${wrapped}${existing.slice(tailStart)}`,
    mode: 'replaced'
  };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Writes `text` by creating a new file next to the target and renaming it over the target.
 * A rename replaces a link at the target instead of following it, so a link planted after the
 * path check cannot redirect the write. A swapped parent folder is not covered; that needs
 * write access to the workspace by another local process.
 */
export async function writeFileAtomic(targetPath: string, text: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporary = join(dirname(targetPath), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    try {
      const existing = await stat(targetPath);
      await chmod(temporary, existing.mode & 0o777);
    } catch {
      // New file: keep the default mode.
    }
    await rename(temporary, targetPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readExistingFile(targetPath: string): Promise<string | undefined> {
  try {
    const stats = await stat(targetPath);
    if (stats.size > MAX_EXISTING_FILE_BYTES) {
      throw new Error('The target file is too large to update (over 5 MB).');
    }
    return await readFile(targetPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** True when git already tracks `absolutePath` in the repository at `directory`. */
export function isTrackedByGit(directory: string, absolutePath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', directory, 'ls-files', '--error-unmatch', '--', absolutePath],
      { timeout: 5000, windowsHide: true },
      (error) => resolvePromise(!error)
    );
  });
}

/** One `.gitignore` line for a path inside the repository root: anchored, glob characters escaped. */
export function gitignoreLine(relativePath: string): string {
  const escaped = relativePath
    .replace(/[\\*?[\]]/g, (character) => `\\${character}`)
    .replace(/^([#!])/, '\\$1')
    .replace(/ +$/g, (spaces) => spaces.replace(/ /g, '\\ '));
  return `/${escaped}`;
}

/**
 * Adds the file to the `.gitignore` at the root of the workspace folder (created if missing).
 * Returns false when the line is already there. The `.gitignore` path is confined like any
 * other: a link in its place is refused.
 */
export async function addToGitignore(workspaceRoot: string, relativePath: string): Promise<boolean> {
  const target = await resolveConfinedFile('.gitignore', workspaceRoot, [workspaceRoot]);
  const line = gitignoreLine(relativePath);
  const existing = (await readExistingFile(target.path)) ?? '';
  if (existing.split(/\r?\n/).some((candidate) => candidate.trim() === line)) {
    return false;
  }

  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await writeFileAtomic(
    target.path,
    `${prefix}${prefix.length > 0 ? '\n' : ''}# FileMaker AI context (generated; contains database structure)\n${line}\n`
  );
  return true;
}
