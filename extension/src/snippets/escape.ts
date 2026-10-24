/**
 * Escaping for the text that "Copy request as code" writes. Everything that comes from a
 * FileMaker database (layout, field and script names, field values, record ids) or from a
 * profile is data, not code: each helper here makes such text inert in the place it lands.
 */

/**
 * Line breaks and control characters that some editor, shell or parser treats as the end of a
 * line (LF, CR, VT, FF, NEL, U+2028, U+2029), plus the rest of the C0/C1 controls.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Makes `value` one visible line: every control character becomes a `\n` / `\xNN` / `\uNNNN` escape. */
export function singleLine(value: string): string {
  return value.replace(UNSAFE_CONTROL, (character) => {
    switch (character) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default: {
        const code = character.charCodeAt(0);
        return code <= 0xff
          ? `\\x${code.toString(16).padStart(2, '0')}`
          : `\\u${code.toString(16).padStart(4, '0')}`;
      }
    }
  });
}

/**
 * Quotes `value` as one POSIX shell word using single quotes. Inside single quotes nothing is
 * special (no `$()`, backticks, `\`, `!`, newlines); the only character that cannot appear is
 * the single quote itself, which is written as `'\''`. A NUL byte cannot be part of an argument,
 * so it is shown as the text `\0` instead of silently ending the word.
 */
export function shellQuote(value: string): string {
  return `'${value.split('\u0000').join('\\0').replace(/'/g, `'\\''`)}'`;
}

/** The text of a shell comment: one line, so it cannot end the comment and start a command. */
export function shellComment(value: string): string {
  return `# ${singleLine(value)}`;
}

/**
 * JSON text that is also safe to paste into a script block, an HTML page or a JavaScript or
 * TypeScript source file: U+2028 and U+2029 are escaped (they end a line in older JavaScript),
 * `</` becomes `<\/` (so `</script>` cannot close a script block) and `<!--` becomes `<\u0021--`.
 * All of these are valid JSON escapes, so the text still parses back to the same value.
 *
 * With `neutralizeTemplates`, a `{` that is followed by another `{` inside a string becomes `\u007b`,
 * so no `{{` is left. Tools that expand `{{name}}` in a request body (VS Code's REST Client, which
 * can read environment variables with `{{$processEnv NAME}}`, and Postman) therefore see no
 * variable in text that came from the database, while an ordinary JSON parameter such as
 * `{"id": 1}` stays readable.
 */
export function safeJson(
  value: unknown,
  options: { space?: number; neutralizeTemplates?: boolean } = {}
): string {
  const text = JSON.stringify(value, null, options.space) ?? 'null';
  return text.replace(/"(?:[^"\\]|\\.)*"/gs, (literal) => {
    let next = literal
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
      .replace(/<\//g, '<\\/')
      .replace(/<!--/g, '<\\u0021--');
    if (options.neutralizeTemplates) {
      next = next.replace(/\{(?=\{)/g, '\\u007b');
    }
    return next;
  });
}

/** A double-quoted JavaScript / TypeScript string literal (the same escapes as `safeJson`). */
export function jsString(value: string, options: { neutralizeTemplates?: boolean } = {}): string {
  return safeJson(value, options);
}

/** Splits text into lines the way an editor does (CR, LF, CRLF) and prefixes every line, so a comment cannot span into code. */
export function prefixedLines(prefix: string, value: string): string[] {
  return singleLine(value)
    .split('\n')
    .map((line) => `${prefix}${line}`);
}

/** A percent-encoded path segment or query component, exactly like the client (`encodeURIComponent`). */
export function encodeComponent(value: string): string {
  return encodeURIComponent(value);
}

/**
 * `a=b&c=d` with every key and value percent-encoded (a space is `%20`, `+` is `%2B`), as the
 * client sends script parameters.
 */
export function encodeQuery(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}
