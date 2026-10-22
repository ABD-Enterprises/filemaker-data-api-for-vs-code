import { FIELD_LAYOUT, standardFieldSize, standardControlFor, orderFields, type StandardFieldMetadata, type FieldLayoutObject, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuideLine {
  orientation: 'vertical' | 'horizontal';
  value: number;
}

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export interface ExecutedCommand<T> {
  label: string;
  before: T;
  after: T;
}

interface ClampRectOptions {
  minWidth?: number;
  minHeight?: number;
}

interface DragInteractionArgs {
  before: LayoutDefinition;
  ids: string[];
  originById: Record<string, Rect>;
  startPoint: Point;
  nextPoint: Point;
}

interface ResizeInteractionArgs {
  before: LayoutDefinition;
  id: string;
  handle: ResizeHandle;
  startPoint: Point;
  nextPoint: Point;
  minWidth?: number;
  minHeight?: number;
}

interface MarqueeSelectionArgs {
  objects: LayoutObject[];
  marquee: Rect;
  baseSelection: string[];
  append: boolean;
}

export function toRect(object: LayoutObject): Rect {
  return {
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height
  };
}

export function normalizeRect(rect: Rect): Rect {
  const nextX = rect.width >= 0 ? rect.x : rect.x + rect.width;
  const nextY = rect.height >= 0 ? rect.y : rect.y + rect.height;

  return {
    x: nextX,
    y: nextY,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height)
  };
}

export function clampRect(
  rect: Rect,
  canvasWidth: number,
  canvasHeight: number,
  options?: ClampRectOptions
): Rect {
  const minWidth = options?.minWidth ?? 1;
  const minHeight = options?.minHeight ?? 1;

  const width = Math.max(minWidth, Math.min(rect.width, canvasWidth));
  const height = Math.max(minHeight, Math.min(rect.height, canvasHeight));
  const x = clamp(rect.x, 0, Math.max(0, canvasWidth - width));
  const y = clamp(rect.y, 0, Math.max(0, canvasHeight - height));

  return {
    x,
    y,
    width,
    height
  };
}

export function resizeRect(rect: Rect, handle: ResizeHandle, dx: number, dy: number, gridSize: number): Rect {
  let x = rect.x;
  let y = rect.y;
  let width = rect.width;
  let height = rect.height;

  if (handle.includes('e')) {
    width = rect.width + dx;
  }

  if (handle.includes('s')) {
    height = rect.height + dy;
  }

  if (handle.includes('w')) {
    x = rect.x + dx;
    width = rect.width - dx;
  }

  if (handle.includes('n')) {
    y = rect.y + dy;
    height = rect.height - dy;
  }

  const normalized = normalizeRect({ x, y, width, height });

  return {
    x: snapToGrid(normalized.x, gridSize),
    y: snapToGrid(normalized.y, gridSize),
    width: snapToGrid(Math.max(normalized.width, 1), gridSize),
    height: snapToGrid(Math.max(normalized.height, 1), gridSize)
  };
}

export function applySmartGuides(target: Rect, others: LayoutObject[]): { rect: Rect; guides: GuideLine[] } {
  const threshold = 5;
  const guides: GuideLine[] = [];

  const targetLeft = target.x;
  const targetCenterX = target.x + target.width / 2;
  const targetRight = target.x + target.width;

  const targetTop = target.y;
  const targetCenterY = target.y + target.height / 2;
  const targetBottom = target.y + target.height;

  let nextX = target.x;
  let nextY = target.y;

  for (const other of others) {
    const otherLeft = other.x;
    const otherCenterX = other.x + other.width / 2;
    const otherRight = other.x + other.width;

    const xCandidates = [
      { source: targetLeft, anchor: otherLeft, offset: 0 },
      { source: targetCenterX, anchor: otherCenterX, offset: -target.width / 2 },
      { source: targetRight, anchor: otherRight, offset: -target.width }
    ];

    for (const candidate of xCandidates) {
      if (Math.abs(candidate.source - candidate.anchor) <= threshold) {
        nextX = candidate.anchor + candidate.offset;
        guides.push({ orientation: 'vertical', value: candidate.anchor });
        break;
      }
    }

    const otherTop = other.y;
    const otherCenterY = other.y + other.height / 2;
    const otherBottom = other.y + other.height;

    const yCandidates = [
      { source: targetTop, anchor: otherTop, offset: 0 },
      { source: targetCenterY, anchor: otherCenterY, offset: -target.height / 2 },
      { source: targetBottom, anchor: otherBottom, offset: -target.height }
    ];

    for (const candidate of yCandidates) {
      if (Math.abs(candidate.source - candidate.anchor) <= threshold) {
        nextY = candidate.anchor + candidate.offset;
        guides.push({ orientation: 'horizontal', value: candidate.anchor });
        break;
      }
    }
  }

  return {
    rect: {
      ...target,
      x: nextX,
      y: nextY
    },
    guides
  };
}

export function computeDragInteraction(args: DragInteractionArgs): { layout: LayoutDefinition; guides: GuideLine[] } {
  const { before, ids, originById, startPoint, nextPoint } = args;

  const gridSize = before.canvas.gridSize;
  const dxRaw = nextPoint.x - startPoint.x;
  const dyRaw = nextPoint.y - startPoint.y;

  let dx = dxRaw;
  let dy = dyRaw;
  let guides: GuideLine[] = [];

  if (ids.length === 1) {
    const objectId = ids[0];
    const origin = originById[objectId];
    const object = before.objects.find((candidate) => candidate.id === objectId);

    if (origin && object) {
      const targetRect: Rect = {
        x: snapToGrid(origin.x + dxRaw, gridSize),
        y: snapToGrid(origin.y + dyRaw, gridSize),
        width: origin.width,
        height: origin.height
      };

      const guideResult = applySmartGuides(
        clampRect(targetRect, before.canvas.width, before.canvas.height),
        before.objects.filter((candidate) => candidate.id !== objectId)
      );

      dx = guideResult.rect.x - origin.x;
      dy = guideResult.rect.y - origin.y;
      guides = guideResult.guides;
    }
  }

  const layout = cloneLayout(before);
  layout.objects = layout.objects.map((item) => {
    if (!ids.includes(item.id)) {
      return item;
    }

    const origin = originById[item.id];
    if (!origin) {
      return item;
    }

    const moved = clampRect(
      {
        x: snapToGrid(origin.x + dx, gridSize),
        y: snapToGrid(origin.y + dy, gridSize),
        width: origin.width,
        height: origin.height
      },
      layout.canvas.width,
      layout.canvas.height
    );

    return {
      ...item,
      x: moved.x,
      y: moved.y
    };
  });

  return {
    layout,
    guides
  };
}

export function computeResizeInteraction(args: ResizeInteractionArgs): { layout: LayoutDefinition; guides: GuideLine[] } {
  const { before, id, handle, startPoint, nextPoint } = args;

  const item = before.objects.find((candidate) => candidate.id === id);
  if (!item) {
    return {
      layout: cloneLayout(before),
      guides: []
    };
  }

  const dx = nextPoint.x - startPoint.x;
  const dy = nextPoint.y - startPoint.y;

  const resized = resizeRect(toRect(item), handle, dx, dy, before.canvas.gridSize);
  const clamped = clampRect(resized, before.canvas.width, before.canvas.height, {
    minWidth: args.minWidth ?? 32,
    minHeight: args.minHeight ?? 24
  });

  const guideResult = applySmartGuides(clamped, before.objects.filter((candidate) => candidate.id !== id));

  const layout = cloneLayout(before);
  layout.objects = layout.objects.map((candidate) =>
    candidate.id === id
      ? {
          ...candidate,
          x: guideResult.rect.x,
          y: guideResult.rect.y,
          width: guideResult.rect.width,
          height: guideResult.rect.height
        }
      : candidate
  );

  return {
    layout,
    guides: guideResult.guides
  };
}

export function selectByMarquee(args: MarqueeSelectionArgs): string[] {
  const normalized = normalizeRect(args.marquee);
  const hitIds = args.objects
    .filter((item) => rectanglesIntersect(normalized, toRect(item)))
    .map((item) => item.id);

  if (!args.append) {
    return hitIds;
  }

  return uniqueIds([...args.baseSelection, ...hitIds]);
}

export function rectanglesIntersect(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

export function layoutsEqual(left: LayoutDefinition, right: LayoutDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function cloneLayout(layout: LayoutDefinition): LayoutDefinition {
  return JSON.parse(JSON.stringify(layout)) as LayoutDefinition;
}

export function pushHistoryEntry<T>(stack: ExecutedCommand<T>[], entry: ExecutedCommand<T>): ExecutedCommand<T>[] {
  return [...stack, entry];
}

export function popHistoryEntry<T>(stack: ExecutedCommand<T>[]): {
  entry: ExecutedCommand<T> | undefined;
  stack: ExecutedCommand<T>[];
} {
  const entry = stack[stack.length - 1];
  if (!entry) {
    return {
      entry: undefined,
      stack
    };
  }

  return {
    entry,
    stack: stack.slice(0, -1)
  };
}

export class UndoRedoStack<T> {
  private undoStack: ExecutedCommand<T>[] = [];
  private redoStack: ExecutedCommand<T>[] = [];

  public push(entry: ExecutedCommand<T>): void {
    this.undoStack = pushHistoryEntry(this.undoStack, entry);
    this.redoStack = [];
  }

  public undo(): ExecutedCommand<T> | undefined {
    const { entry, stack } = popHistoryEntry(this.undoStack);
    if (!entry) {
      return undefined;
    }
    this.undoStack = stack;
    this.redoStack = pushHistoryEntry(this.redoStack, entry);
    return entry;
  }

  public redo(): ExecutedCommand<T> | undefined {
    const { entry, stack } = popHistoryEntry(this.redoStack);
    if (!entry) {
      return undefined;
    }
    this.redoStack = stack;
    this.undoStack = pushHistoryEntry(this.undoStack, entry);
    return entry;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  public get undoCount(): number {
    return this.undoStack.length;
  }

  public get redoCount(): number {
    return this.redoStack.length;
  }
}

export function snapToGrid(value: number, gridSize: number): number {
  if (!Number.isFinite(gridSize) || gridSize <= 1) {
    return Math.round(value);
  }

  return Math.round(value / gridSize) * gridSize;
}

export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function withNormalizedZIndex(layout: LayoutDefinition, ordered: LayoutObject[]): LayoutDefinition {
  const nextById = new Map<string, number>();
  ordered.forEach((item, index) => {
    nextById.set(item.id, index);
  });

  return {
    ...layout,
    objects: layout.objects.map((item) => ({
      ...item,
      zIndex: nextById.get(item.id) ?? item.zIndex
    }))
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Only geometry and label position change; bindings, order and all other data survive. */
export function standardizeFields(
  layout: LayoutDefinition,
  fields: StandardFieldMetadata[],
  ids?: string[]
): LayoutDefinition {
  const objects = layout.objects.map((object) => {
    if (object.type !== 'field' || (ids && !ids.includes(object.id))) return object;
    const metadata = fields.find((field) => field.name === object.fmFieldName);
    const size = standardFieldSize({ ...metadata, displayType: object.displayType === 'editBox' ? metadata?.displayType : object.displayType });
    // Move left/up before growing; reserve the top label as Arrange does.
    const maxX = Math.max(0, Math.floor((layout.canvas.width - size.width) / FIELD_LAYOUT.grid) * FIELD_LAYOUT.grid);
    const maxY = Math.max(0, Math.floor((layout.canvas.height - size.height - FIELD_LAYOUT.labelSpace) / FIELD_LAYOUT.grid) * FIELD_LAYOUT.grid);
    return { ...object, ...size,
      x: clamp(snapToGrid(object.x, FIELD_LAYOUT.grid), 0, maxX),
      y: clamp(snapToGrid(object.y, FIELD_LAYOUT.grid), 0, maxY),
      labelPosition: FIELD_LAYOUT.labelPosition
    };
  });
  const changed = objects.filter((object, index) => object !== layout.objects[index]);
  return { ...layout, objects, canvas: { ...layout.canvas,
    width: Math.max(layout.canvas.width, ...changed.map((object) => object.x + object.width)),
    height: Math.max(layout.canvas.height, ...changed.map((object) => object.y + object.height + FIELD_LAYOUT.labelSpace))
  } };
}

/** Column-major order: the first half runs down the left, the rest down the right. */
export function arrangeStandardForm(
  layout: LayoutDefinition,
  fields: StandardFieldMetadata[],
  columns: 1 | 2 = 1,
  ids?: string[]
): LayoutDefinition {
  if (!layout.objects.some((object) => (object.type === 'field' || object.type === 'portal') && (!ids || ids.includes(object.id)))) return layout;
  const next = standardizeFields(layout, fields, ids);
  const included = (object: LayoutObject): boolean => !ids || ids.includes(object.id);
  const names = orderFields({ fields }, Object.fromEntries(next.objects.filter((object) => object.type === 'field' && included(object)).map((object) => [(object as FieldLayoutObject).fmFieldName, true])));
  const order = new Map(names.map((name, index) => [name, index]));
  const arranged = next.objects.filter((object) => object.type === 'field' && included(object))
    .sort((a, b) => (order.get((a as FieldLayoutObject).fmFieldName) ?? fields.length)
      - (order.get((b as FieldLayoutObject).fmFieldName) ?? fields.length));
  const columnWidth = Math.max(FIELD_LAYOUT.textWidth, ...arranged.map((object) => object.width));
  const actualColumns = columns === 2 && layout.canvas.width >= FIELD_LAYOUT.pageMargin * 2 + columnWidth * 2 + FIELD_LAYOUT.columnGap ? 2 : 1;
  const split = Math.ceil(arranged.length / actualColumns);
  const selected = layout.objects.filter((object) => included(object) && (object.type === 'field' || object.type === 'portal'));
  const originX = ids ? Math.max(0, snapToGrid(Math.min(...selected.map((object) => object.x)), FIELD_LAYOUT.grid)) : FIELD_LAYOUT.pageMargin;
  const originY = ids ? Math.max(0, snapToGrid(Math.min(...selected.map((object) => object.y)), FIELD_LAYOUT.grid)) : FIELD_LAYOUT.pageMargin;
  const bottom = [originY, originY];
  const positions = new Map<string, Partial<LayoutObject>>();
  arranged.forEach((object, index) => {
    const column = index < split ? 0 : 1;
    positions.set(object.id, { x: originX + column * (columnWidth + FIELD_LAYOUT.columnGap), y: bottom[column] });
    // Reserve room for the top label and round upwards, so the 34 px controls cannot overlap.
    bottom[column] += Math.ceil((object.height + FIELD_LAYOUT.labelSpace + FIELD_LAYOUT.rowGap) / FIELD_LAYOUT.grid) * FIELD_LAYOUT.grid;
  });
  let portalY = Math.max(...bottom);
  const fullWidth = Math.max(columnWidth, layout.canvas.width - originX - FIELD_LAYOUT.pageMargin);
  next.objects.filter((object) => object.type === 'portal' && included(object)).forEach((object) => {
    positions.set(object.id, { x: originX, y: portalY, width: fullWidth });
    portalY += Math.ceil((object.height + FIELD_LAYOUT.rowGap) / FIELD_LAYOUT.grid) * FIELD_LAYOUT.grid;
  });
  // Shift the whole selected block, including labels, below conflicts; unrelated objects stay put.
  if (ids) {
    const obstacles = next.objects.filter((object) => !included(object));
    let shift = 0;
    for (;;) {
      const conflicts = obstacles.filter((obstacle) => [...positions].some(([id, position]) => {
        const object = next.objects.find((item) => item.id === id)!;
        return rectanglesIntersect({ ...object, ...position, y: position.y! + shift,
          height: object.height + (object.type === 'field' ? FIELD_LAYOUT.labelSpace : 0) },
          { ...obstacle, height: obstacle.height + (obstacle.type === 'field' ? FIELD_LAYOUT.labelSpace : 0) });
      }));
      if (!conflicts.length) break;
      shift = Math.ceil((Math.max(...conflicts.map((object) => object.y + object.height
        + (object.type === 'field' ? FIELD_LAYOUT.labelSpace : 0))) + FIELD_LAYOUT.rowGap - originY) / FIELD_LAYOUT.grid) * FIELD_LAYOUT.grid;
    }
    for (const position of positions.values()) position.y! += shift;
    portalY += shift;
  }
  return {
    ...next,
    canvas: {
      ...next.canvas,
      width: Math.max(next.canvas.width, originX + columnWidth * actualColumns + (actualColumns - 1) * FIELD_LAYOUT.columnGap + FIELD_LAYOUT.pageMargin),
      height: Math.max(next.canvas.height, portalY + FIELD_LAYOUT.pageMargin)
    },
    objects: next.objects.map((object) => positions.has(object.id) ? { ...object, ...positions.get(object.id) } as LayoutObject : object)
  };
}

export type StarterTemplate = 'blank' | 'form' | 'twoColumn' | 'formPortal';
export interface StandardPortalMetadata { name: string; fields: string[] }

export function createStandardField(
  metadata: StandardFieldMetadata & { required?: boolean },
  id: string,
  point: Point,
  zIndex: number
): FieldLayoutObject {
  const standard = standardControlFor(metadata);
  return {
    id, name: metadata.name, type: 'field', fmFieldName: metadata.name,
    x: Math.max(0, snapToGrid(point.x, FIELD_LAYOUT.grid)),
    y: Math.max(0, snapToGrid(point.y, FIELD_LAYOUT.grid)),
    ...standardFieldSize(metadata), zIndex,
    anchors: { top: true, right: false, bottom: false, left: true },
    displayType: standard.kind === 'checkbox' ? 'checkbox' : standard.kind === 'radio' ? 'radio' : standard.kind === 'select' ? 'dropdown' : 'editBox',
    format: metadata.type?.toLowerCase() === 'number' ? 'number' : metadata.type?.toLowerCase() === 'date' ? 'date' : 'text',
    kind: metadata.kind ?? (metadata.type?.toLowerCase() === 'container' ? 'container' : 'normal'),
    multiline: standard.kind === 'textarea',
    result: metadata.result || metadata.type,
    options: metadata.options ? [...metadata.options] : undefined,
    labelPosition: FIELD_LAYOUT.labelPosition, required: metadata.required ?? false
  };
}

/** Default additions continue the standard column. Drops keep their requested slot when free. */
export function nextStandardFieldPosition(layout: LayoutDefinition, metadata: StandardFieldMetadata, point?: Point): Point {
  const size = standardFieldSize(metadata);
  const x = point ? Math.max(0, snapToGrid(point.x, FIELD_LAYOUT.grid)) : FIELD_LAYOUT.pageMargin;
  let y = point ? Math.max(0, snapToGrid(point.y, FIELD_LAYOUT.grid)) : FIELD_LAYOUT.pageMargin;
  const obstacles = layout.objects.map((object) => ({ ...object, height: object.height + (object.type === 'field' ? FIELD_LAYOUT.labelSpace : 0) }));
  if (!point && obstacles.length) y = Math.max(y, ...obstacles.map((object) => object.y + object.height + FIELD_LAYOUT.rowGap));
  y = Math.ceil(y / FIELD_LAYOUT.grid) * FIELD_LAYOUT.grid;
  while (true) {
    const conflicts = obstacles.filter((object) => rectanglesIntersect({ x, y, ...size, height: size.height + FIELD_LAYOUT.labelSpace }, object));
    if (!conflicts.length) return { x, y };
    y = Math.ceil(Math.max(...conflicts.map((object) => object.y + object.height + FIELD_LAYOUT.rowGap)) / FIELD_LAYOUT.grid) * FIELD_LAYOUT.grid;
  }
}

/** IDs are supplied by the caller, keeping template generation pure and repeatable. */
export function createStarterTemplate(
  layout: LayoutDefinition,
  fields: StandardFieldMetadata[],
  template: StarterTemplate,
  ids: string[],
  portal?: StandardPortalMetadata
): LayoutDefinition {
  if (template === 'blank') return layout;
  const objects: LayoutObject[] = fields.map((field, index) => createStandardField(field, ids[index], { x: 0, y: 0 }, index));
  if (template === 'formPortal' && portal) {
    objects.push({
      id: ids[fields.length], name: portal.name, type: 'portal', relatedContext: portal.name,
      x: 0, y: 0, width: 420, height: 220, zIndex: objects.length,
      anchors: { top: true, right: false, bottom: false, left: true },
      rowCount: 5, scroll: true, selectableRows: false,
      columns: portal.fields.map((name, index) => ({ id: ids[fields.length + 1 + index], fmFieldName: name, label: name, width: FIELD_LAYOUT.textWidth }))
    });
  }
  return arrangeStandardForm({ ...layout, objects }, fields, template === 'twoColumn' ? 2 : 1);
}
