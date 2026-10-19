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
    ids.forEach((id, i) => {
      const field = container.querySelector<HTMLElement>(`[data-fm-field-id="${id}"]`)!;
      expect(field.style.left).toBe('24px');
      expect(field.style.top).toBe(`${y}px`);
      expect(Number.parseFloat(field.style.width)).toBeLessThanOrEqual(172);
      y += layout.objects[i].height + 24 + 16;
    });
    expect(Number.parseFloat((container.firstChild as HTMLElement).style.height)).toBe(y + 24);
    expect(FIELD_LAYOUT).toMatchObject({ pageMargin: 24, rowGap: 16, columnGap: 24 });
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
