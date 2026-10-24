import { createBlankLayout, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';
import { describe, expect, it } from 'vitest';

import {
  computeDragInteraction,
  computeResizeInteraction,
  popHistoryEntry,
  pushHistoryEntry,
  selectByMarquee,
  toRect,
  type ExecutedCommand
} from './canvas-engine';

function rectangleObject(options: {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}): LayoutObject {
  return {
    id: options.id,
    type: 'rectangle',
    name: options.id,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    zIndex: options.zIndex,
    cornerRadius: 0,
    anchors: {
      top: true,
      right: false,
      bottom: false,
      left: true
    }
  };
}

function makeLayout(objects: LayoutObject[], gridSize = 8): LayoutDefinition {
  const layout = createBlankLayout('Canvas Test');
  return {
    ...layout,
    canvas: {
      width: 400,
      height: 300,
      gridSize
    },
    objects
  };
}

describe('canvas engine interactions', () => {
  it('drag interaction snaps to grid and clamps to canvas bounds', () => {
    const object = rectangleObject({ id: 'obj-1', x: 280, y: 40, width: 100, height: 40, zIndex: 0 });
    const before = makeLayout([object], 8);

    const result = computeDragInteraction({
      before,
      ids: [object.id],
      originById: {
        [object.id]: toRect(object)
      },
      startPoint: { x: 0, y: 0 },
      nextPoint: { x: 45, y: 17 }
    });

    const moved = result.layout.objects[0];
    expect(moved.x).toBe(300);
    expect(moved.y).toBe(56);
    expect(result.guides).toEqual([]);
  });

  it('drag interaction applies smart guides for single-object alignment', () => {
    const moving = rectangleObject({ id: 'obj-a', x: 10, y: 10, width: 40, height: 20, zIndex: 0 });
    const anchor = rectangleObject({ id: 'obj-b', x: 120, y: 70, width: 50, height: 20, zIndex: 1 });
    const before = makeLayout([moving, anchor], 1);

    const result = computeDragInteraction({
      before,
      ids: [moving.id],
      originById: {
        [moving.id]: toRect(moving)
      },
      startPoint: { x: 0, y: 0 },
      nextPoint: { x: 109, y: 0 }
    });

    const moved = result.layout.objects.find((item) => item.id === moving.id);
    expect(moved?.x).toBe(120);
    expect(moved?.y).toBe(10);
    expect(result.guides.some((guide) => guide.orientation === 'vertical' && guide.value === 120)).toBe(true);
  });

  it('resize interaction snaps dimensions to grid', () => {
    const object = rectangleObject({ id: 'obj-1', x: 40, y: 40, width: 80, height: 60, zIndex: 0 });
    const before = makeLayout([object], 8);

    const result = computeResizeInteraction({
      before,
      id: object.id,
      handle: 'se',
      startPoint: { x: 0, y: 0 },
      nextPoint: { x: 18, y: 10 }
    });

    const resized = result.layout.objects[0];
    expect(resized.width).toBe(96);
    expect(resized.height).toBe(72);
  });

  it('marquee selection supports replacement and append selection modes', () => {
    const a = rectangleObject({ id: 'a', x: 10, y: 10, width: 20, height: 20, zIndex: 0 });
    const b = rectangleObject({ id: 'b', x: 120, y: 120, width: 20, height: 20, zIndex: 1 });
    const c = rectangleObject({ id: 'c', x: 50, y: 10, width: 20, height: 20, zIndex: 2 });

    const replaceSelection = selectByMarquee({
      objects: [a, b, c],
      marquee: { x: 0, y: 0, width: 60, height: 60 },
      baseSelection: ['b'],
      append: false
    });

    const appendSelection = selectByMarquee({
      objects: [a, b, c],
      marquee: { x: 0, y: 0, width: 60, height: 60 },
      baseSelection: ['b'],
      append: true
    });

    expect(replaceSelection).toEqual(['a', 'c']);
    expect(appendSelection).toEqual(['b', 'a', 'c']);
  });

  it('history helpers preserve LIFO undo/redo semantics', () => {
    const cmd1: ExecutedCommand<number> = { label: 'cmd1', before: 0, after: 1 };
    const cmd2: ExecutedCommand<number> = { label: 'cmd2', before: 1, after: 2 };

    let undoStack: ExecutedCommand<number>[] = [];
    let redoStack: ExecutedCommand<number>[] = [];

    undoStack = pushHistoryEntry(undoStack, cmd1);
    undoStack = pushHistoryEntry(undoStack, cmd2);

    const undoStep = popHistoryEntry(undoStack);
    undoStack = undoStep.stack;
    redoStack = pushHistoryEntry(redoStack, undoStep.entry as ExecutedCommand<number>);

    expect(undoStep.entry?.label).toBe('cmd2');
    expect(undoStack).toEqual([cmd1]);

    const redoStep = popHistoryEntry(redoStack);
    redoStack = redoStep.stack;
    undoStack = pushHistoryEntry(undoStack, redoStep.entry as ExecutedCommand<number>);

    expect(redoStep.entry?.label).toBe('cmd2');
    expect(redoStack).toEqual([]);
    expect(undoStack.map((entry) => entry.label)).toEqual(['cmd1', 'cmd2']);
  });
});
