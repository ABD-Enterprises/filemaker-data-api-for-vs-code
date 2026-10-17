import { createRequire } from 'module';

import { describe, expect, it } from 'vitest';

interface Criterion {
  field: string;
  operator: string;
  value: string;
  value2: string;
}

interface FindFormModel {
  requests: Array<{ omit: boolean; criteria: Criterion[] }>;
  sort: Array<{ fieldName: string; sortOrder: string }>;
}

interface FindFormApi {
  OPERATORS: Array<{ id: string }>;
  criterionToFindValue(criterion: Partial<Criterion>): string;
  findValueToCriterion(field: string, raw: string | number): Criterion;
  createEmptyModel(): FindFormModel;
  modelToFindQuery(model: FindFormModel): Array<Record<string, string>>;
  findDuplicateField(model: FindFormModel): string | undefined;
  modelToSort(model: FindFormModel): Array<{ fieldName: string; sortOrder: string }>;
  jsonToModel(findText: string, sortText?: string): { ok: boolean; reason?: string; model?: FindFormModel };
}

const FindForm = createRequire(import.meta.url)(
  '../../src/webviews/queryBuilder/ui/findForm.js'
) as FindFormApi;

describe('Query Builder find form', () => {
  it('maps every operator to FileMaker find syntax and back', () => {
    const cases: Array<[string, Partial<Criterion>, string]> = [
      ['match', { value: 'Smith' }, 'Smith'],
      ['equals', { value: 'Smith' }, '==Smith'],
      ['begins', { value: 'Sm' }, '==Sm*'],
      ['contains', { value: 'John Smith' }, '*"John Smith"'],
      ['gt', { value: '10' }, '>10'],
      ['gte', { value: '10' }, '>=10'],
      ['lt', { value: '10' }, '<10'],
      ['lte', { value: '10' }, '<=10'],
      ['between', { value: '1/1/2026', value2: '12/31/2026' }, '1/1/2026...12/31/2026'],
      ['empty', {}, '='],
      ['notEmpty', {}, '*']
    ];

    expect(cases.map(([operator]) => operator).sort()).toEqual(FindForm.OPERATORS.map((op) => op.id).sort());

    for (const [operator, values, expected] of cases) {
      expect(FindForm.criterionToFindValue({ operator, ...values })).toBe(expected);
      const parsed = FindForm.findValueToCriterion('Field', expected);
      expect(parsed.operator).toBe(operator);
      expect(FindForm.criterionToFindValue(parsed)).toBe(expected);
    }
  });

  it('escapes FileMaker operator characters except under "matches"', () => {
    expect(FindForm.criterionToFindValue({ operator: 'equals', value: 'a@b.com' })).toBe('==a\\@b.com');
    expect(FindForm.criterionToFindValue({ operator: 'contains', value: 'say "hi" 50%*' })).toBe('*"say \\"hi\\" 50%*"');
    expect(FindForm.criterionToFindValue({ operator: 'match', value: 'a@b.com' })).toBe('a@b.com');
    expect(FindForm.findValueToCriterion('Email', '==a\\@b.com')).toMatchObject({
      operator: 'equals',
      value: 'a@b.com'
    });
  });

  it('round-trips every non-"matches" condition for awkward values', () => {
    const chars = ['*', '=', '>', '<', '.', 'a', ' ', '@', '\\', '/', '…'];
    const values: string[] = [];
    for (const first of chars) {
      for (const second of chars) {
        for (const third of ['', ...chars]) {
          values.push(first + second + third);
        }
      }
    }
    const operators = FindForm.OPERATORS.map((op) => op.id).filter(
      (id) => !['match', 'empty', 'notEmpty'].includes(id)
    );
    for (const operator of operators) {
      for (const value of values) {
        const value2 = operator === 'between' ? [...value].reverse().join('') : '';
        const encoded = FindForm.criterionToFindValue({ operator, value, value2 });
        expect(FindForm.findValueToCriterion('F', encoded), `${operator} ${encoded}`).toMatchObject({
          operator,
          value,
          value2
        });
      }
    }
  });

  it('leaves raw find JSON unchanged when it passes through the form', () => {
    const raw = ['<//', '==*@gmail.com', '*a@b*', '1/1/2020...//', '==C:\\temp', 'Sm*', '1..5', '**'];
    const parsed = FindForm.jsonToModel(JSON.stringify(raw.map((value) => ({ F: value }))));
    expect(parsed.ok).toBe(true);
    expect(FindForm.modelToFindQuery(parsed.model!).map((request) => request.F)).toEqual(raw);

    const chars = ['*', '=', '>', '<', '.', 'a', '@', '\\', '/', '…'];
    for (const first of chars) {
      for (const second of chars) {
        for (const third of ['', ...chars]) {
          const value = first + second + third;
          expect(FindForm.criterionToFindValue(FindForm.findValueToCriterion('F', value)), value).toBe(value);
        }
      }
    }
  });

  it('escapes two-period runs so equals never becomes a range', () => {
    expect(FindForm.criterionToFindValue({ operator: 'equals', value: 'a..b' })).toBe('==a\\.\\.b');
  });

  it('reports a field used twice in one request', () => {
    const model = FindForm.createEmptyModel();
    model.requests[0] = {
      omit: false,
      criteria: [
        { field: 'Date', operator: 'gte', value: '1/1/2026', value2: '' },
        { field: 'Date ', operator: 'lte', value: '12/31/2026', value2: '' }
      ]
    };
    expect(FindForm.findDuplicateField(model)).toBe('Date');
    model.requests[0].criteria.pop();
    expect(FindForm.findDuplicateField(model)).toBeUndefined();
  });

  it('builds OR requests, omit flags, and skips rows without a field', () => {
    const model: FindFormModel = {
      requests: [
        {
          omit: false,
          criteria: [
            { field: 'Status', operator: 'equals', value: 'Open', value2: '' },
            { field: '  ', operator: 'match', value: 'ignored', value2: '' }
          ]
        },
        { omit: true, criteria: [{ field: 'Region', operator: 'match', value: 'West', value2: '' }] },
        { omit: false, criteria: [{ field: '', operator: 'match', value: '', value2: '' }] }
      ],
      sort: [
        { fieldName: 'Name', sortOrder: 'ascend' },
        { fieldName: 'Created', sortOrder: 'descend' },
        { fieldName: '', sortOrder: 'ascend' }
      ]
    };

    expect(FindForm.modelToFindQuery(model)).toEqual([
      { Status: '==Open' },
      { Region: 'West', omit: 'true' }
    ]);
    expect(FindForm.modelToSort(model)).toEqual([
      { fieldName: 'Name', sortOrder: 'ascend' },
      { fieldName: 'Created', sortOrder: 'descend' }
    ]);
  });

  it('returns an empty request when no criteria are filled in', () => {
    expect(FindForm.modelToFindQuery(FindForm.createEmptyModel())).toEqual([{}]);
  });

  it('round-trips JSON through the form model', () => {
    const find = '[{"Status":"==Open","Amount":">100"},{"Region":"West","omit":"true"}]';
    const sort = '[{"fieldName":"Amount","sortOrder":"descend"}]';
    const parsed = FindForm.jsonToModel(find, sort);

    expect(parsed.ok).toBe(true);
    expect(FindForm.modelToFindQuery(parsed.model!)).toEqual(JSON.parse(find));
    expect(FindForm.modelToSort(parsed.model!)).toEqual(JSON.parse(sort));
  });

  it('refuses JSON the form cannot show faithfully', () => {
    expect(FindForm.jsonToModel('not json').ok).toBe(false);
    expect(FindForm.jsonToModel('{"a":"b"}').ok).toBe(false);
    expect(FindForm.jsonToModel('[{"Portal::Field":{"nested":true}}]').ok).toBe(false);
    expect(FindForm.jsonToModel('[{}]', '[{"fieldName":"A","sortOrder":"ByValueList"}]').ok).toBe(false);
  });

  it('accepts numeric values and an empty request', () => {
    const parsed = FindForm.jsonToModel('[{"Qty": 5}]');
    expect(parsed.ok).toBe(true);
    expect(FindForm.modelToFindQuery(parsed.model!)).toEqual([{ Qty: '5' }]);

    const empty = FindForm.jsonToModel('[{}]');
    expect(empty.ok).toBe(true);
    expect(empty.model!.requests[0]?.criteria).toHaveLength(1);
  });
});
