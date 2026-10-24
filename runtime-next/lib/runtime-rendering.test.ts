import { describe, expect, it } from 'vitest';

import {
  applyAnchoredRuntimeRect,
  computePortalVisibleRange,
  createBlankLayout,
  type LayoutObject
} from '@fmweb/shared';

describe('runtime rendering helpers', () => {
  it('computes portal virtualization window for large row sets', () => {
    const rangeTop = computePortalVisibleRange(100, 256, 32, 0);
    expect(rangeTop.start).toBe(0);
    expect(rangeTop.end).toBeLessThan(100);

    const rangeMiddle = computePortalVisibleRange(100, 256, 32, 640);
    expect(rangeMiddle.start).toBeGreaterThan(0);
    expect(rangeMiddle.end).toBeLessThanOrEqual(100);
    expect(rangeMiddle.end - rangeMiddle.start).toBeLessThan(30);
  });

  it('applies anchor-based responsive positioning', () => {
    const layout = createBlankLayout('Anchors');
    const viewport = {
      width: layout.canvas.width + 200,
      height: layout.canvas.height + 120
    };

    const leftRightObject: LayoutObject = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'rectangle',
      name: 'stretch-width',
      x: 20,
      y: 20,
      width: 200,
      height: 60,
      zIndex: 0,
      cornerRadius: 0,
      anchors: { top: true, right: true, bottom: false, left: true }
    };

    const rightOnlyObject: LayoutObject = {
      id: '22222222-2222-4222-8222-222222222222',
      type: 'rectangle',
      name: 'shift-right',
      x: 40,
      y: 40,
      width: 120,
      height: 40,
      zIndex: 1,
      cornerRadius: 0,
      anchors: { top: true, right: true, bottom: false, left: false }
    };

    const stretched = applyAnchoredRuntimeRect(leftRightObject, layout, viewport);
    const shifted = applyAnchoredRuntimeRect(rightOnlyObject, layout, viewport);

    expect(stretched.width).toBe(leftRightObject.width + 200);
    expect(stretched.x).toBe(leftRightObject.x);
    expect(shifted.x).toBe(rightOnlyObject.x + 200);
  });
});
