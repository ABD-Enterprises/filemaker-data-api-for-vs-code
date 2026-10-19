import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createBlankLayout, FIELD_LAYOUT, standardFieldSize, type LayoutDefinition } from '@fmweb/shared';
import { loadLayoutDefinition } from './layout-loader';
import LayoutPage from '../app/layouts/[id]/page';

vi.mock('./layout-loader', () => ({ loadLayoutDefinition: vi.fn() }));
vi.mock('../app/layouts/[id]/runtime-layout-client', async () => {
  const { LayoutContainer } = await import('@fmweb/shared');
  return { RuntimeLayoutClient: ({ layout }: { layout: LayoutDefinition }) => React.createElement(LayoutContainer, { layout, mode: 'runtime' }) };
});

function fixture(): LayoutDefinition {
  const layout = createBlankLayout(' Exact layout ', ' Source ');
  layout.objects = ['text', 'number', 'date', 'time', 'timestamp', 'long text', 'container'].map((type, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, type: 'field', name: type,
    fmFieldName: ` ${type} `, displayType: 'editBox', format: 'text', required: false,
    labelPosition: FIELD_LAYOUT.labelPosition, ...standardFieldSize({ type }),
    x: 24, y: 24 + i * 220, zIndex: i, anchors: { top: true, left: true, right: false, bottom: false }
  }));
  return layout;
}

describe('web layout view page', () => {
  it('renders the shared standard widths, full control heights and top labels', async () => {
    vi.mocked(loadLayoutDefinition).mockResolvedValue(fixture());
    const markup = renderToStaticMarkup(await LayoutPage({ params: { id: 'layout' } }));
    expect(markup).toContain('data-fm-field-layout="standard"');
    for (const [width, height] of [[240, 34], [120, 34], [160, 34], [240, 96], [240, 160]]) {
      expect(markup).toContain(`data-fm-width="${width}" data-fm-height="${height}"`);
      expect(markup).toContain(`width:${width}px;height:${height + 24}px`);
    }
    expect(markup.match(/data-fm-label-position="top"/g)).toHaveLength(7);
    expect(markup).toContain(' text ');
    expect(markup).toContain('gap: 16px 24px');
    expect(markup).toMatch(/@media \(max-width: 640px\)[\s\S]*flex-direction: column/);
  });
});
