import { describe, expect, it } from 'vitest';

import { encodeQuery, jsString, prefixedLines, safeJson, shellComment, shellQuote, singleLine } from '../../../src/snippets/escape';

describe('shellQuote', () => {
  it('wraps in single quotes and writes a single quote as \'\\\'\'', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("''")).toBe("''\\'''\\'''");
  });

  it('leaves $(), backticks, backslashes, ! and newlines literal', () => {
    expect(shellQuote('$(id) `id` \\ ! \n')).toBe("'$(id) `id` \\ ! \n'");
  });

  it('shows a NUL byte as text instead of ending the argument', () => {
    expect(shellQuote('a\u0000b')).toBe("'a\\0b'");
  });
});

describe('singleLine and comments', () => {
  it('turns every line break and control character into a visible escape', () => {
    expect(singleLine('a\nb\rc\td')).toBe('a\\nb\\rc\\td');
    expect(singleLine('a\u2028b\u2029c\u0085d\u000be\u000cf\u0000g')).toBe('a\\u2028b\\u2029c\\x85d\\x0be\\x0cf\\x00g');
    expect(singleLine('line')).not.toMatch(/[\n\r]/);
  });

  it('a shell comment cannot end and start a command', () => {
    expect(shellComment('x\ntouch /tmp/y')).toBe('# x\\ntouch /tmp/y');
    expect(prefixedLines('// ', 'a\r\nb')).toEqual(['// a\\r\\nb']);
    expect(prefixedLines('// ', 'a\nb')).toEqual(['// a\\nb']);
  });
});

describe('safeJson and jsString', () => {
  it('round-trips every value, including what it escapes', () => {
    const value = { a: '\u2028\u2029</script><!--', 'k"ey': ['\u0000', '{{x}}', 'café \u{1F600}'], n: 1, b: true, z: null };
    for (const options of [{}, { space: 2 }, { neutralizeTemplates: true }, { space: 2, neutralizeTemplates: true }]) {
      expect(JSON.parse(safeJson(value, options))).toEqual(value);
    }
  });

  it('never writes U+2028, U+2029, </ or <!-- raw', () => {
    const text = safeJson({ a: '\u2028\u2029</script><!-- x', '</b>': 1 });
    expect(text).not.toMatch(/\u2028|\u2029/);
    expect(text).not.toContain('</');
    expect(text).not.toContain('<!--');
    expect(text).toContain('<\\/script>');
  });

  it('breaks every {{ inside strings when asked, and leaves ordinary braces alone', () => {
    const text = safeJson({ param: '{{$processEnv HOME}} {{{x}}} {"id": 1}' }, { neutralizeTemplates: true });
    expect(text).not.toContain('{{');
    expect(text).toContain('{"id": 1}'.replace(/"/g, '\\"'));
    expect(text.startsWith('{"param"')).toBe(true);
  });

  it('jsString is a double-quoted literal that evaluates back to the text', () => {
    const value = 'say "hi"\n\\ \u2028 </script> ${x} `y`';
    expect(new Function(`return ${jsString(value)}`)()).toBe(value);
    expect(jsString(value)).not.toContain('\u2028');
  });
});

describe('encodeQuery', () => {
  it('percent-encodes keys and values with %20 for a space and %2B for +', () => {
    expect(encodeQuery([['script.param', 'a b+c&d=e/f']])).toBe('script.param=a%20b%2Bc%26d%3De%2Ff');
    expect(encodeQuery([['a', '1'], ['b', '2']])).toBe('a=1&b=2');
  });
});
