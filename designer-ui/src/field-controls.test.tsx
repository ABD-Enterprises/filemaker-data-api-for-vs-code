import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as standards from '@fmweb/shared';
import { createStandardField, createStarterTemplate } from './canvas-engine';

describe('layout field order', () => {
  it('groups repetitions numerically, keeps exact names and response order for extras, and never reveals absent fields', () => {
    const metadata = { fieldMetaData: [{ name: ' Z ' }, { name: 'Name' }, { name: 'Hidden' }, { name: 'Name' }] };
    const data = { extraZ: '', 'Name(10)': '', extraA: '', 'Name(2)': '', ' Z ': '', 'Name(1)': '', Name: '' };
    expect(standards.orderFields(metadata, data)).toEqual([' Z ', 'Name', 'Name(1)', 'Name(2)', 'Name(10)', 'extraZ', 'extraA']);
    expect(Object.keys(data)[0]).toBe('extraZ');
    expect(standards.orderFields(undefined, data)).toEqual(Object.keys(data));
    expect(standards.orderFields({ fieldMetaData: [{ name: 'Hidden' }] }, {})).toEqual([]);
  });
});

const cases: Array<readonly [standards.StandardFieldMetadata, standards.StandardControlKind, number, number, boolean]> = [
  [{ name: 'Text', type: 'text' }, 'input', 240, 34, false],
  [{ name: 'Qty', type: 'number' }, 'input', 120, 34, false],
  ...['date', 'time', 'timestamp'].map((type) => [{ name: type, type }, 'input', 160, 34, false] as const),
  [{ name: 'Notes', type: 'long text' }, 'textarea', 240, 96, false],
  [{ name: 'Notes', result: 'text', value: 'a\nb' }, 'textarea', 240, 96, false],
  [{ name: 'Notes', type: 'text', maxLength: 500 }, 'textarea', 240, 96, false],
  [{ name: 'Notes', displayType: 'editText', height: 2 }, 'textarea', 240, 96, false],
  ...['popupMenu', 'dropdown', 'dropDownList'].map((displayType) => [{ name: 'Status', displayType, options: ['Active'] }, 'select', 240, 34, false] as const),
  [{ name: 'Flags', displayType: 'checkBox', options: ['A', 'B'] }, 'checkbox', 240, 48, false],
  [{ name: 'Choice', displayType: 'radioButtons', optionCount: 3 }, 'radio', 240, 72, false],
  [{ name: 'Photo', type: 'container' }, 'container', 240, 160, true],
  [{ name: 'Calc', kind: 'calculation', type: 'number' }, 'input', 120, 34, true],
  [{ name: 'Total', type: 'summary', result: 'number' }, 'input', 120, 34, true],
  [{ name: 'Global', kind: 'global' }, 'input', 240, 34, false]
];

it.each(cases)('chooses the standard control for %j', (field, kind, width, height, readOnly) => {
  expect(standards.standardControlFor(field)).toEqual({ kind, width, height, readOnly });
});

it('Editor controls and FM Web render the same elements, sizes, unknown choices and read-only kinds', () => {
  for (const [metadata, kind, width, height] of cases) {
    const field = { ...metadata, options: ['A', 'B'] };
    const value = metadata.value === undefined ? 'Unlisted' : String(metadata.value);
    const editor = standards.createStandardControl(document, field, value, () => undefined);
    const layout = standards.createBlankLayout('Parity');
    layout.objects = [createStandardField(field, 'field', { x: 24, y: 24 }, 0)];
    const markup = renderToStaticMarkup(<standards.LayoutContainer layout={layout} mode="runtime"
      runtimeData={{ editing: true, fieldValues: { [field.name]: value } }} />);
    const runtime = document.createElement('div');
    runtime.innerHTML = markup;
    const selector = kind === 'checkbox' || kind === 'radio' ? `input[type="${kind}"]` : kind === 'container' ? '.fm-container' : kind;
    expect(editor.matches(selector) || editor.querySelector(selector) !== null, field.name).toBe(true);
    expect(runtime.querySelector(selector), field.name).not.toBeNull();
    expect(markup).toContain(`data-fm-width="${width}"`);
    expect(markup).toContain(`data-fm-height="${height}"`);
    if (kind === 'select') {
      expect(editor.querySelector('option[value="Unlisted"]')?.textContent).toBe('Unlisted (current value)');
      expect(runtime.querySelector('option[value="Unlisted"]')?.textContent).toBe('Unlisted (current value)');
    }
  }
});

it('starter forms group repeated fields in layout order', () => {
  const fields = [{ name: 'Z' }, { name: 'A(10)' }, { name: 'A(2)' }, { name: 'A(1)' }];
  const layout = createStarterTemplate(standards.createBlankLayout('Order'), fields, 'form', ['z', 'ten', 'two', 'one']);
  expect([...layout.objects].sort((a, b) => a.y - b.y).map((field) => field.name)).toEqual(['Z', 'A(1)', 'A(2)', 'A(10)']);
});

it('keeps radio groups independent when the same layout field is searched twice', () => {
  const changes: string[] = [];
  const field = { name: ' Exact choice ', displayType: 'radio', options: ['A', 'B'] };
  const first = standards.createStandardControl(document, field, 'A', (value) => changes.push(value));
  const second = standards.createStandardControl(document, field, 'A', () => undefined);
  document.body.append(first, second);
  try {
    first.querySelectorAll<HTMLInputElement>('input')[1].click();
    expect(changes).toEqual(['B']);
    expect(second.querySelectorAll<HTMLInputElement>('input')[0].checked).toBe(true);
  } finally { first.remove(); second.remove(); }
});

it('grows multiline runtime controls without overlapping the next saved row or changing the layout', () => {
  const layout = standards.createBlankLayout('Tall values');
  layout.objects = [createStandardField({ name: 'Notes' }, 'notes', { x: 24, y: 24 }, 0),
    createStandardField({ name: 'Next' }, 'next', { x: 24, y: 104 }, 1)];
  const markup = renderToStaticMarkup(<standards.LayoutContainer layout={layout} mode="runtime"
    runtimeData={{ fieldValues: { Notes: 'first\nsecond', Next: 'after' } }} />);
  const host = document.createElement('div'); host.innerHTML = markup;
  const first = host.querySelector<HTMLElement>('[data-fm-field-id="notes"]')!;
  const next = host.querySelector<HTMLElement>('[data-fm-field-id="next"]')!;
  expect(first.querySelector('textarea')).not.toBeNull();
  expect(first.getAttribute('data-fm-height')).toBe('96');
  expect(parseFloat(next.style.top)).toBeGreaterThanOrEqual(parseFloat(first.style.top) + parseFloat(first.style.height) + 16);
  expect(layout.objects.map((object) => [object.y, object.height])).toEqual([[24, 34], [104, 34]]);
});

it('uses the shared read-only look for calculated and summary runtime controls', () => {
  for (const kind of ['calculation', 'summary'] as const) {
    const layout = standards.createBlankLayout('Read-only');
    layout.objects = [createStandardField({ name: 'Total', type: 'number', kind }, 'total', { x: 24, y: 24 }, 0)];
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<standards.LayoutContainer layout={layout} mode="runtime"
      runtimeData={{ editing: true, fieldValues: { Total: 10235.9 } }} />);
    const control = host.querySelector<HTMLInputElement>('input')!;
    expect(control.readOnly).toBe(true);
    expect(control.classList.contains('fm-readonly')).toBe(true);
    expect(control.style.borderStyle).toBe('dashed');
    expect(control.style.resize).toBe('none');
  }
});
