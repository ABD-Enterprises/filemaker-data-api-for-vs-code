import { describe, expect, it } from 'vitest';

import { parseFindRequest, parseSnippetOperation } from '../../../src/snippets/operationInput';

describe('parseFindRequest', () => {
  it('takes a list of requests or an object with query, sort, limit and offset', () => {
    expect(parseFindRequest([{ A: 'x' }])).toEqual({ query: [{ A: 'x' }] });
    expect(parseFindRequest({ query: [{ A: 'x' }], sort: [{ fieldName: 'A' }], limit: 5, offset: 2 })).toEqual({
      query: [{ A: 'x' }],
      sort: [{ fieldName: 'A' }],
      limit: 5,
      offset: 2
    });
  });

  it('refuses anything else', () => {
    for (const value of [null, 1, 'x', [], [1], {}, { query: [] }, { query: [{}], limit: 0 }, { query: [{}], limit: 'x' }, { query: [{}], sort: 'x' }]) {
      expect(parseFindRequest(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe('parseSnippetOperation', () => {
  it('accepts each operation with its fields', () => {
    expect(parseSnippetOperation({ kind: 'login' })).toEqual({ kind: 'login' });
    expect(parseSnippetOperation({ kind: 'getRecord', layout: 'L', recordId: '1' })).toEqual({ kind: 'getRecord', layout: 'L', recordId: '1' });
    expect(parseSnippetOperation({ kind: 'runScript', layout: 'L', scriptName: 'S', scriptParam: 'p', recordId: '3' })).toEqual({
      kind: 'runScript',
      layout: 'L',
      scriptName: 'S',
      scriptParam: 'p',
      recordId: '3'
    });
    expect(parseSnippetOperation({ kind: 'uploadContainer', layout: 'L', recordId: '1', fieldName: 'F', fieldRepetition: 2, withModId: true })).toMatchObject({
      fieldRepetition: 2,
      withModId: true
    });
  });

  it('refuses unknown kinds, missing and mistyped fields, and prototype keys', () => {
    const refused: unknown[] = [
      null,
      'login',
      {},
      { kind: 'nope' },
      { kind: 'getRecord', layout: 'L' },
      { kind: 'getRecord', layout: 1, recordId: '1' },
      { kind: 'createRecord', layout: 'L', fieldData: [] },
      { kind: 'runScript', layout: 'L', scriptName: 'S', scriptParam: 5 },
      { kind: 'uploadContainer', layout: 'L', recordId: '1', fieldName: 'F', fieldRepetition: 1.5 },
      { kind: 'find', layout: 'L', request: { query: [] } },
      JSON.parse('{"kind":"createRecord","layout":"L","fieldData":{"__proto__":{"x":1}}}'),
      { kind: 'getRecord', layout: 'x'.repeat(2000), recordId: '1' }
    ];
    for (const value of refused) {
      expect(parseSnippetOperation(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});
