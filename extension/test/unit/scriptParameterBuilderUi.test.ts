import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

import { describe, expect, it, vi } from 'vitest';

type ParameterRow = {
  key: string;
  type: string;
  value: string;
};

type BuilderResult = {
  json: string;
  error: string;
};

type BuildParameterJson = (rows: ParameterRow[]) => BuilderResult;
type CreateRowsFromExistingParameter = (parameter: string) => ParameterRow[];

interface FakeClassList {
  add: (...tokens: string[]) => void;
  remove: (...tokens: string[]) => void;
  toggle: (token: string, force?: boolean) => boolean;
  contains: (token: string) => boolean;
}

interface FakeElement {
  children: FakeElement[];
  style: Record<string, string>;
  dataset: Record<string, string>;
  classList: FakeClassList;
  className: string;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  type: string;
  id: string;
  htmlFor: string;
  placeholder: string;
  rows: number;
  step: string;
  inputMode: string;
  appendChild: (child: FakeElement) => FakeElement;
  append: (...children: FakeElement[]) => void;
  replaceChildren: (...children: FakeElement[]) => void;
  insertBefore: (child: FakeElement, before: FakeElement | null) => FakeElement;
  remove: () => void;
  addEventListener: (type: string, listener: unknown) => void;
  setAttribute: (name: string, value: string) => void;
  querySelector: (selector: string) => FakeElement | null;
  querySelectorAll: (selector: string) => FakeElement[];
  focus: () => void;
}

function createFakeElement(): FakeElement {
  const classNames = new Set<string>();
  const element: Omit<FakeElement, 'className'> = {
    children: [],
    style: {},
    dataset: {},
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    type: '',
    id: '',
    htmlFor: '',
    placeholder: '',
    rows: 0,
    step: '',
    inputMode: '',
    classList: {
      add: (...tokens: string[]) => {
        tokens.forEach((token) => classNames.add(token));
      },
      remove: (...tokens: string[]) => {
        tokens.forEach((token) => classNames.delete(token));
      },
      toggle: (token: string, force?: boolean) => {
        const shouldAdd = force ?? !classNames.has(token);
        if (shouldAdd) {
          classNames.add(token);
        } else {
          classNames.delete(token);
        }
        return shouldAdd;
      },
      contains: (token: string) => classNames.has(token)
    },
    appendChild: (child: FakeElement) => {
      element.children.push(child);
      return child;
    },
    append: (...children: FakeElement[]) => {
      element.children.push(...children);
    },
    replaceChildren: (...children: FakeElement[]) => {
      element.children = [...children];
    },
    insertBefore: (child: FakeElement, before: FakeElement | null) => {
      const index = before ? element.children.indexOf(before) : -1;
      if (index >= 0) {
        element.children.splice(index, 0, child);
      } else {
        element.children.push(child);
      }
      return child;
    },
    remove: vi.fn(),
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    focus: vi.fn()
  };

  Object.defineProperty(element, 'className', {
    get: () => Array.from(classNames).join(' '),
    set: (value: string) => {
      classNames.clear();
      value
        .split(/\s+/)
        .filter(Boolean)
        .forEach((token) => classNames.add(token));
    }
  });

  return element as FakeElement;
}

function loadBuilderHelpers(): {
  buildParameterJson: BuildParameterJson;
  createRowsFromExistingParameter: CreateRowsFromExistingParameter;
} {
  const uiScriptPath = resolve(__dirname, '../../src/webviews/scriptRunner/ui/index.js');
  const source = readFileSync(uiScriptPath, 'utf8');
  const elements = new Map<string, FakeElement>();
  const document = {
    getElementById: (id: string) => {
      let element = elements.get(id);
      if (!element) {
        element = createFakeElement();
        element.id = id;
        elements.set(id, element);
      }
      return element;
    },
    createElement: () => createFakeElement(),
    querySelector: () => null,
    querySelectorAll: () => []
  };

  const context = vm.createContext({
    acquireVsCodeApi: () => ({
      postMessage: vi.fn()
    }),
    document,
    window: {
      addEventListener: vi.fn()
    }
  });

  new vm.Script(source, { filename: uiScriptPath }).runInContext(context);
  const globals = context as Record<string, unknown>;
  const buildParameterJson = globals.buildParameterJson;
  const createRowsFromExistingParameter = globals.createRowsFromExistingParameter;

  expect(buildParameterJson).toBeTypeOf('function');
  expect(createRowsFromExistingParameter).toBeTypeOf('function');

  return {
    buildParameterJson: buildParameterJson as BuildParameterJson,
    createRowsFromExistingParameter:
      createRowsFromExistingParameter as CreateRowsFromExistingParameter
  };
}

describe('script parameter JSON builder UI helpers', () => {
  it('serializes string, number, boolean, and JSON rows into parseable JSON', () => {
    const { buildParameterJson } = loadBuilderHelpers();

    const result = buildParameterJson([
      { key: 'name', type: 'string', value: 'Ada' },
      { key: 'count', type: 'number', value: '42.5' },
      { key: 'enabled', type: 'bool', value: 'true' },
      { key: 'payload', type: 'json', value: '{"ids":[1,2],"mode":"sync"}' }
    ]);

    expect(result.error).toBe('');
    expect(JSON.parse(result.json)).toEqual({
      name: 'Ada',
      count: 42.5,
      enabled: true,
      payload: {
        ids: [1, 2],
        mode: 'sync'
      }
    });
  });

  it('returns targeted validation errors for bad builder rows', () => {
    const { buildParameterJson } = loadBuilderHelpers();

    expect(
      buildParameterJson([{ key: 'count', type: 'number', value: 'not-a-number' }])
    ).toMatchObject({
      json: '',
      error: 'Row 1: enter a valid number.'
    });
    expect(
      buildParameterJson([{ key: 'payload', type: 'json', value: '{"unterminated"' }])
    ).toMatchObject({
      json: '',
      error: 'Row 1: enter valid JSON.'
    });
    expect(
      buildParameterJson([
        { key: 'id', type: 'string', value: '1' },
        { key: 'id', type: 'number', value: '2' }
      ])
    ).toMatchObject({
      json: '',
      error: 'Row 2: key "id" is duplicated.'
    });
  });

  it('hydrates rows from an existing JSON object with matching value types', () => {
    const { createRowsFromExistingParameter } = loadBuilderHelpers();

    expect(
      createRowsFromExistingParameter(
        JSON.stringify({
          name: 'Ada',
          count: 7,
          enabled: false,
          payload: { ids: [1, 2] },
          blank: null
        })
      )
    ).toEqual([
      { key: 'name', type: 'string', value: 'Ada' },
      { key: 'count', type: 'number', value: '7' },
      { key: 'enabled', type: 'bool', value: 'false' },
      { key: 'payload', type: 'json', value: '{\n  "ids": [\n    1,\n    2\n  ]\n}' },
      { key: 'blank', type: 'json', value: 'null' }
    ]);
  });
});
