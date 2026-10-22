// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankLayout, LayoutContainer, type FieldLayoutObject } from '@fmweb/shared';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function field(overrides: Partial<FieldLayoutObject> = {}): FieldLayoutObject {
  return { id: '11111111-1111-4111-8111-111111111111', type: 'field', name: ' Field ', fmFieldName: ' Field ',
    x: 24, y: 24, width: 240, height: 34, zIndex: 0, anchors: { left: true, top: true, right: false, bottom: false },
    displayType: 'editBox', format: 'text', required: false, labelPosition: 'top', ...overrides };
}
const onFieldChange = vi.fn();
function render(object: FieldLayoutObject, value?: unknown, editing = false, mode: 'runtime' | 'designer' = 'runtime'): void {
  const layout = createBlankLayout('Fields'); layout.objects = [object];
  act(() => root.render(React.createElement(LayoutContainer, { layout, mode, runtimeData: {
    fieldValues: { [object.fmFieldName]: value }, editing, onFieldChange
  } })));
}

describe('runtime field values', () => {
  it('keeps empty and whitespace values exact; sample text belongs only to the designer', () => {
    for (const value of [undefined, null, '']) {
      render(field(), value); expect(host.querySelector('input')?.value).toBe('');
    }
    render(field(), '  exact  '); expect(host.querySelector('input')?.value).toBe('  exact  ');
    render(field(), undefined, false, 'designer'); expect(host.querySelector('input')?.value).toBe(' Field ');
  });
  it('uses a text control for the server date string and explains its format', () => {
    render(field({ format: 'date' }), '31/12/2026', true);
    expect(host.querySelector('input')?.type).toBe('text');
    expect(host.querySelector('input')?.value).toBe('31/12/2026');
    expect(host.textContent).toContain('server');
    expect(host.querySelector('input')?.readOnly).toBe(false);
  });
  it.each(['calculation', 'summary', 'container'] as const)('%s stays read-only in edit mode with the Editor note', (kind) => {
    render(field({ kind }), kind === 'container' ? 'https://example.com/file.pdf' : '12', true);
    expect(host.querySelector('input:not([readonly]):not(:disabled),textarea:not([readonly]):not(:disabled),select:not(:disabled)')).toBeNull();
    expect(host.textContent).toContain(kind === 'calculation' ? 'Calculated by FileMaker; cannot be edited' : kind === 'summary' ? 'Summary field; cannot be edited' : 'Use Upload to container');
  });
  it('allows global and multiline fields to be edited and explains global scope', () => {
    render(field({ kind: 'global', multiline: true, height: 96 }), 'a\nb', true);
    expect(host.querySelector('textarea')?.readOnly).toBe(false);
    expect(host.querySelector('textarea')?.value).toBe('a\nb');
    expect(host.textContent).toContain('Session-wide: changes apply throughout this session.');
  });
  it('shows image container URLs as images, other safe URLs as links, and empty containers empty', () => {
    render(field({ kind: 'container' }), 'https://example.com/photo.jpg?token=a');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://example.com/photo.jpg?token=a');
    render(field({ kind: 'container' }), 'https://example.com/file.pdf');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/file.pdf');
    render(field({ kind: 'container' }), 'javascript:alert(1)'); expect(host.querySelector('a,img')).toBeNull();
    render(field({ kind: 'container' }), ''); expect(host.querySelector('a,img,input')).toBeNull();
  });
  it('dropdown, checkbox, radio and multiline controls report edits under the exact field name', () => {
    render(field({ displayType: 'dropdown', options: ['a', 'b'] }), 'a', true);
    act(() => {
      const select = host.querySelector('select')!; select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'b');
    render(field({ displayType: 'checkbox', options: ['a', 'b'] }), 'a', true);
    act(() => host.querySelectorAll<HTMLInputElement>('input')[1].click());
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'a\rb');
    render(field({ displayType: 'radio', options: ['a', 'b'] }), 'a', true);
    act(() => host.querySelectorAll<HTMLInputElement>('input')[1].click());
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'b');
    render(field({ multiline: true }), 'old', true);
    act(() => {
      const input = host.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'new\ntext');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'new\ntext');
  });

  it('does not invent related rows or values in runtime portals', () => {
    const layout = createBlankLayout('Portal'); layout.objects = [{ ...field(), type: 'portal', relatedContext: 'Related',
      rowCount: 2, columns: [{ id: 'col', fmFieldName: 'Name', label: 'Name', width: 120 }], scroll: true, selectableRows: false }];
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime' })));
    expect(host.querySelectorAll('[data-fm-portal-row]')).toHaveLength(0);
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: {
      portalRowsByObjectId: { [layout.objects[0].id]: [{ Name: '' }] }
    } })));
    expect(host.querySelector('[data-fm-portal-cell]')?.textContent).toBe('');
  });
});
