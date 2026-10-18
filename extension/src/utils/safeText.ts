import { createHash } from 'crypto';

/**
 * Text that comes from a FileMaker database (layout, field and script names) or a profile is
 * written into generated source files and file names. Whoever can name things in the database
 * controls it, so it is escaped for the place it lands.
 */

/**
 * Makes `value` safe to put inside a line or block comment: control characters and line
 * breaks (including U+2028 and U+2029) become visible escapes, so the text cannot end the
 * comment or start a new line of code, and the end-of-comment marker cannot close a block comment early.
 */
export function commentText(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/\*\//g, '*\\/');
}

/** Escapes `value` for the inside of a single-quoted JavaScript or TypeScript string literal. */
export function singleQuotedText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Escapes `value` for the default text of a VS Code snippet placeholder (`${1:value}`). */
export function snippetPlaceholderText(value: string): string {
  return singleQuotedText(value).replace(/[\\$}]/g, (character) => `\\${character}`);
}

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Turns a file-safe base name (already reduced to letters, digits and `_.-`) into one that
 * cannot collide with a different original name or mean something special:
 *  - when the original had characters that were dropped or replaced (other than plain
 *    spaces and underscores), a short hash of the original is appended, so `A/B` and `A:B`
 *    stay two files;
 *  - Windows device names (`CON`, `NUL`, `COM1`, ...) get a leading underscore;
 *  - a name made only of dots, or empty, becomes `layout`.
 */
export function distinctFileName(original: string, sanitized: string, fallback = 'layout'): string {
  let name = sanitized;
  if (name.length === 0 || /^\.+$/.test(name)) {
    name = fallback;
  }

  if (/[^A-Za-z0-9_.\-\s]/.test(original.trim()) || name === fallback) {
    const hash = createHash('sha1').update(original).digest('hex').slice(0, 6);
    name = name === fallback && original.trim().length === 0 ? name : `${name}-${hash}`;
  }

  return WINDOWS_RESERVED_NAMES.test(name) ? `_${name}` : name;
}
