import * as React from 'react';
import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlankLayout, LayoutContainer, FIELD_LAYOUT } from '@fmweb/shared';
import { createStarterTemplate } from './canvas-engine';

const fields = [{ name: ' Text ', type: 'text' }, { name: 'N', type: 'number' }, { name: 'D', type: 'date' },
  { name: 'T', type: 'time' }, { name: 'TS', type: 'timestamp' }, { name: 'Notes', type: 'long text' }, { name: 'Photo', type: 'container' }];
const ids = fields.map((_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
const fixture = () => createStarterTemplate(createBlankLayout('Presentation', ' Exact source '), fields, 'twoColumn', ids);
afterEach(cleanup);

describe('shared designer and runtime presentation', () => {
  it.each(['designer', 'runtime'] as const)('%s reserves a full top label and the same standard control sizes', (mode) => {
    const layout = fixture();
    const { container } = render(<LayoutContainer layout={layout} mode={mode} />);
    const expected = [[240, 34], [120, 34], [160, 34], [160, 34], [160, 34], [240, 96], [240, 160]];
    ids.forEach((id, i) => {
      const field = container.querySelector<HTMLElement>(`[data-fm-field-id="${id}"]`)!;
      const [width, height] = expected[i];
      expect(field.style.width).toBe(`${width}px`);
      expect(field.style.height).toBe(`${height + 24}px`);
      expect(field.getAttribute('data-fm-label-position')).toBe('top');
      expect(field.querySelector('input')?.style.height).toBe(`${height}px`);
      expect(field.querySelector('label')?.style.height).toBe('24px');
    });
    expect(container.querySelector('label')?.textContent).toBe(' Text ');
  });

  it('narrow runtime stacks saved objects with the standard margin and row gap and grows to fit', () => {
    const layout = fixture();
    const { container } = render(<LayoutContainer layout={layout} mode="runtime" runtimeData={{ viewport: { width: 220, height: 200 } }} />);
    let y = 24;
    [...layout.objects].sort((a, b) => a.y - b.y || a.x - b.x).forEach((object) => {
      const field = container.querySelector<HTMLElement>(`[data-fm-field-id="${object.id}"]`)!;
      expect(field.style.left).toBe('24px');
      expect(field.style.top).toBe(`${y}px`);
      expect(Number.parseFloat(field.style.width)).toBeLessThanOrEqual(172);
      y += object.height + 24 + 16;
    });
    expect(Number.parseFloat((container.firstChild as HTMLElement).style.height)).toBe(y + 24);
    expect(FIELD_LAYOUT).toMatchObject({ pageMargin: 24, rowGap: 16, columnGap: 24 });
  });

  it('narrow runtime uses visual y/x order for controls only, preserving decorative geometry and paint order', () => {
    const layout = fixture();
    const base = layout.objects[0];
    const anchors = { top: true, left: true, right: false, bottom: false };
    layout.objects = [
      { ...base, id: 'bottom', y: 400, x: 24, zIndex: 0 },
      { ...base, id: 'right', y: 40, x: 300, zIndex: 1 },
      { ...base, id: 'left', y: 40, x: 24, zIndex: 2 },
      { ...base, id: 'button', type: 'button', label: 'Action', y: 200, x: 24, height: 34, zIndex: 3 },
      { ...base, id: 'portal', type: 'portal', relatedContext: 'Related', columns: [], rowCount: 1, scroll: true, selectableRows: false, y: 300, x: 24, height: 160, zIndex: 4 },
      { ...base, id: 'text', type: 'text', text: 'Decoration', y: 10, x: 80, width: 300, height: 20, zIndex: 5, anchors },
      { ...base, id: 'shape', type: 'rectangle', cornerRadius: 0, y: 12, x: 82, width: 300, height: 22, zIndex: -1, anchors }
    ] as typeof layout.objects;
    const { container } = render(<LayoutContainer layout={layout} mode="runtime" runtimeData={{ viewport: { width: 400, height: 100 } }} />);
    const fields = ['left', 'right', 'bottom'].map((id) => container.querySelector<HTMLElement>(`[data-fm-field-id="${id}"]`)!);
    expect(fields.map((field) => field.style.top)).toEqual(['24px', '98px', '398px']);
    const button = container.querySelector('button')!;
    expect(button.style.top).toBe('172px');
    const portal = container.querySelector<HTMLElement>('[data-fm-portal-id]')!;
    expect(portal.style.top).toBe('222px');
    const text = [...container.querySelectorAll('div')].find((element) => element.textContent === 'Decoration')!;
    expect([text.style.left, text.style.top, text.style.width]).toEqual(['80px', '10px', '300px']);
    const shape = (container.firstChild as HTMLElement).firstChild as HTMLElement;
    expect([shape.style.left, shape.style.top, shape.style.width]).toEqual(['82px', '12px', '300px']);
    // Reflow does not change z-order or mutate the saved layout.
    expect([...container.querySelectorAll('[data-fm-field-id]')].map((element) => element.getAttribute('data-fm-field-id'))).toEqual(['bottom', 'right', 'left']);
    expect(layout.objects[0].y).toBe(400);
  });

  it('wide runtime preserves designer geometry including intentional overrides', () => {
    const layout = fixture();
    layout.objects[0].width = 320;
    layout.objects[0].height = 56;
    const designer = render(<LayoutContainer layout={layout} mode="designer" />);
    const runtime = render(<LayoutContainer layout={layout} mode="runtime" runtimeData={{ viewport: layout.canvas }} />);
    expect(runtime.container.querySelector('[data-fm-field-id]')?.getAttribute('style'))
      .toBe(designer.container.querySelector('[data-fm-field-id]')?.getAttribute('style'));
  });
});
