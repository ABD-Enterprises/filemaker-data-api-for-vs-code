// Find-request semantics for the mock. An approximation of FileMaker's find operators, not a
// specification: == exact (or prefix with trailing *), *"phrase", < > <= >=, a...b, = empty,
// * not empty, a plain value matches a word prefix, and backslash escapes a metacharacter.
const unescapeFind = (v) => String(v).replace(/\\(.)/g, '$1');
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const toDate = (v) => {
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : undefined;
};

export function cmpVal(field) {
  const s = String(field ?? '');
  const n = toNum(s);
  if (n !== undefined && s.trim() !== '') return n;
  const d = toDate(s);
  if (d !== undefined && /\//.test(s)) return d;
  return s.toLowerCase();
}

export function fieldMatches(value, criterion) {
  const c = String(criterion);
  const text = String(value ?? '');
  const lower = text.toLowerCase();
  if (c === '=') return text === '';
  if (c === '*') return text !== '';
  const phrase = c.match(/^\*"((?:[^"\\]|\\.)*)"$/);
  if (phrase) return lower.includes(unescapeFind(phrase[1]).toLowerCase());
  if (c.startsWith('==')) {
    const rest = c.slice(2);
    if (rest.endsWith('*') && !rest.endsWith('\\*'))
      return lower.startsWith(unescapeFind(rest.slice(0, -1)).toLowerCase());
    return lower === unescapeFind(rest).toLowerCase();
  }
  for (const [op, fn] of [
    ['>=', (a, b) => a >= b],
    ['<=', (a, b) => a <= b],
    ['>', (a, b) => a > b],
    ['<', (a, b) => a < b]
  ]) {
    if (c.startsWith(op))
      return text !== '' && fn(cmpVal(text), cmpVal(unescapeFind(c.slice(op.length))));
  }
  const range = c.match(/^((?:[^.\\]|\\.)+)\.\.\.((?:[^.\\]|\\.)+)$/);
  if (range) {
    const v = cmpVal(text);
    return (
      text !== '' && v >= cmpVal(unescapeFind(range[1])) && v <= cmpVal(unescapeFind(range[2]))
    );
  }
  // FileMaker wildcards: * is any run of characters (a word is matched from its start), @ one character.
  if (/(^|[^\\])[*@]/.test(c)) {
    let re = '';
    for (let i = 0; i < c.length; i += 1) {
      const ch = c[i];
      if (ch === '\\' && i + 1 < c.length) {
        re += c[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        i += 1;
      } else if (ch === '*') re += '.*';
      else if (ch === '@') re += '.';
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    const pattern = new RegExp(`^${re}`, 'i');
    return lower.split(/[\s,]+/).some((w) => pattern.test(w)) || pattern.test(text);
  }
  const needle = unescapeFind(c).toLowerCase();
  return lower.split(/[\s,]+/).some((w) => w.startsWith(needle));
}

/**
 * @param rows candidate rows
 * @param query array of request objects (criteria + optional omit)
 * @param valueOf (row, fieldName) => the field's value (own field) or array of values (related)
 * Requests are applied in order, like FileMaker's: an include request adds its hits to the found set,
 * an omit request removes its hits from the found set built so far, and a query that starts with an
 * omit request starts from every row. So [A, omit B] and [omit B, A] can differ.
 */
export function runFind(rows, query, valueOf) {
  let found = null;
  for (const request of query) {
    const { omit, ...criteria } = request;
    const isOmit = String(omit).toLowerCase() === 'true';
    const hits = rows.filter((r) =>
      Object.entries(criteria).every(([f, c]) => {
        const v = valueOf(r, f);
        return Array.isArray(v) ? v.some((x) => fieldMatches(x, c)) : fieldMatches(v, c);
      })
    );
    if (isOmit) {
      found ??= new Set(rows);
      for (const r of hits) found.delete(r);
    } else {
      found ??= new Set();
      for (const r of hits) found.add(r);
    }
  }
  found ??= new Set(rows);
  return rows.filter((r) => found.has(r));
}
