import * as React from 'react';
import { FIELD_LAYOUT } from './field-standards';

import type { FieldLayoutObject, LayoutDefinition, LayoutObject, PortalLayoutObject } from './layout-schema';

export interface RuntimeLayoutData {
  fieldValues?: Record<string, unknown>;
  portalRowsByObjectId?: Record<string, Array<Record<string, unknown>>>;
  viewport?: {
    width: number;
    height: number;
  };
}

export interface LayoutRendererProps {
  layout: LayoutDefinition;
  mode: 'designer' | 'runtime';
  onObjectAction?: (object: LayoutObject) => void;
  runtimeData?: RuntimeLayoutData;
}

export function LayoutContainer({
  layout,
  mode,
  onObjectAction,
  runtimeData
}: LayoutRendererProps): React.JSX.Element {
  const viewport = mode === 'runtime' ? runtimeData?.viewport : undefined;
  const containerWidth = viewport ? Math.max(1, Math.round(viewport.width)) : layout.canvas.width;
  const narrow = viewport !== undefined && viewport.width <= 640;
  const containerHeight = viewport ? Math.max(1, Math.round(viewport.height)) : layout.canvas.height;

  const renderedObjects = React.useMemo(
    () =>
      layout.objects
        .slice()
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((object) => applyAnchoredRuntimeRect(object, layout, viewport)),
    [layout, viewport]
  );

  // Stack controls in the designer's visual order, while retaining paint order and decorative geometry.
  let flowY = FIELD_LAYOUT.pageMargin;
  const positions = new Map<string, LayoutObject>();
  if (narrow) {
    layout.objects.filter((object) => ['field', 'portal', 'button'].includes(object.type))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .forEach((object) => {
        positions.set(object.id, { ...object, x: FIELD_LAYOUT.pageMargin, y: flowY,
          width: Math.min(object.width, Math.max(1, containerWidth - FIELD_LAYOUT.pageMargin * 2)) });
        flowY += object.height + (object.type === 'field' && object.labelPosition === 'top' ? FIELD_LAYOUT.labelSpace : 0) + FIELD_LAYOUT.rowGap;
      });
  }
  const visibleObjects = renderedObjects.map((object) => positions.get(object.id) ?? object);

  return (
    <div
      data-mode={mode}
      style={{
        position: 'relative',
        width: containerWidth,
        height: narrow ? Math.max(containerHeight, flowY + FIELD_LAYOUT.pageMargin) : containerHeight,
        backgroundColor: layout.styles.colors.surface,
        color: layout.styles.colors.text,
        fontFamily: layout.styles.typography.fontFamily,
        fontSize: layout.styles.typography.fontSize,
        overflow: 'hidden',
        borderRadius: 10,
        boxShadow: '0 10px 25px rgba(18, 35, 56, 0.12)'
      }}
    >
      {visibleObjects.map((object) => (
        <LayoutObjectRenderer
          key={object.id}
          object={object}
          mode={mode}
          onObjectAction={onObjectAction}
          runtimeData={runtimeData}
        />
      ))}
    </div>
  );
}

interface LayoutObjectRendererProps {
  object: LayoutObject;
  mode: 'designer' | 'runtime';
  onObjectAction?: (object: LayoutObject) => void;
  runtimeData?: RuntimeLayoutData;
}

function LayoutObjectRenderer({
  object,
  mode,
  onObjectAction,
  runtimeData
}: LayoutObjectRendererProps): React.JSX.Element {
  const sharedStyle: React.CSSProperties = {
    position: 'absolute',
    left: object.x,
    top: object.y,
    width: object.width,
    height: object.height,
    boxSizing: 'border-box'
  };

  switch (object.type) {
    case 'field':
      return <FieldControl style={sharedStyle} object={object} mode={mode} runtimeData={runtimeData} />;
    case 'portal':
      return <PortalControl style={sharedStyle} object={object} mode={mode} runtimeData={runtimeData} />;
    case 'button':
      return <ButtonControl style={sharedStyle} object={object} onObjectAction={onObjectAction} />;
    case 'text':
      return <div style={sharedStyle}>{object.text}</div>;
    case 'image':
      return <div style={{ ...sharedStyle, border: '1px dashed #96a5b5', background: '#f2f6fa' }}>Image</div>;
    case 'tabPanel':
      return <div style={{ ...sharedStyle, border: '1px solid #ced8e3', background: '#fbfcfd' }}>Tab Panel</div>;
    case 'rectangle':
      return (
        <div
          style={{
            ...sharedStyle,
            border: '1px solid #b8c6d8',
            borderRadius: object.cornerRadius,
            background: '#f6f9fc'
          }}
        />
      );
    default:
      return <div style={sharedStyle} />;
  }
}

type ButtonLayoutObject = Extract<LayoutObject, { type: 'button' }>;

function ButtonControl(props: {
  style: React.CSSProperties;
  object: ButtonLayoutObject;
  onObjectAction?: (object: LayoutObject) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-fm-button-id={props.object.id}
      data-fm-behavior-type={props.object.behavior?.type ?? ''}
      style={{
        ...props.style,
        border: '1px solid #2c6f98',
        borderRadius: 6,
        background: '#2274a5',
        color: '#ffffff',
        cursor: 'pointer'
      }}
      onClick={() => props.onObjectAction?.(props.object)}
    >
      {props.object.label}
    </button>
  );
}

function FieldControl(props: {
  style: React.CSSProperties;
  object: FieldLayoutObject;
  mode: 'designer' | 'runtime';
  runtimeData?: RuntimeLayoutData;
}): React.JSX.Element {
  const { object, style } = props;
  const labelText = object.label?.trim().length ? object.label : object.fmFieldName;
  const runtimeValue = props.runtimeData?.fieldValues?.[object.fmFieldName];
  const previewOptions = getPreviewOptions(object, runtimeValue);
  const showLabel = object.labelPosition !== 'none';
  const horizontalLabel = object.labelPosition === 'left' || object.labelPosition === 'right';
  const inputId = `field-input-${object.id}`;
  const inlineControlStyle: React.CSSProperties = {
    flex: horizontalLabel ? 1 : '0 0 auto',
    minWidth: 0,
    minHeight: object.height,
    height: object.height,
    flexShrink: horizontalLabel ? 1 : 0,
    display: 'flex',
    alignItems: 'center'
  };

  const labelNode = showLabel ? (
    <label
      htmlFor={object.displayType === 'radio' ? undefined : inputId}
      style={{
        height: horizontalLabel ? undefined : FIELD_LAYOUT.labelSpace,
        flexShrink: 0,
        overflowWrap: 'anywhere',
        fontSize: 12,
        color: '#526980',
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minWidth: horizontalLabel ? 74 : undefined,
        maxWidth: horizontalLabel ? '45%' : undefined
      }}
    >
      <span>{labelText}</span>
      {object.required ? (
        <span data-required-indicator="true" style={{ color: '#b21e3b' }}>
          *
        </span>
      ) : null}
    </label>
  ) : null;

  const fieldControl = renderFieldDisplayControl({
    object,
    mode: props.mode,
    inputId,
    options: previewOptions
  });

  return (
    <div
      style={{
        ...style,
        height: object.height + (object.labelPosition === 'top' ? FIELD_LAYOUT.labelSpace : 0),
        display: 'flex',
        flexDirection: horizontalLabel ? 'row' : 'column',
        justifyContent: horizontalLabel ? 'space-between' : undefined,
        alignItems: horizontalLabel ? 'center' : undefined,
        gap: horizontalLabel ? 6 : 0
      }}
      data-fm-width={object.width}
      data-fm-height={object.height}
      data-fm-field-id={object.id}
      data-fm-field-control={object.displayType}
      data-fm-field-format={object.format}
      data-fm-label-position={object.labelPosition}
    >
      {object.labelPosition === 'right' ? (
        <>
          <div style={inlineControlStyle}>{fieldControl}</div>
          {labelNode}
        </>
      ) : (
        <>
          {labelNode}
          <div style={inlineControlStyle}>{fieldControl}</div>
        </>
      )}
    </div>
  );
}

function renderFieldDisplayControl(props: {
  object: FieldLayoutObject;
  mode: 'designer' | 'runtime';
  inputId: string;
  options: string[];
}): React.JSX.Element {
  const disabled = props.mode === 'designer';
  const baseControlStyle: React.CSSProperties = {
    border: '1px solid #90a3b8',
    borderRadius: 5,
    width: '100%',
    height: props.object.height,
    minHeight: props.object.height,
    padding: '4px 8px',
    boxSizing: 'border-box',
    background: disabled ? '#f6fafc' : '#ffffff',
    color: '#20364f'
  };

  if (props.object.displayType === 'dropdown') {
    return (
      <select
        id={props.inputId}
        disabled={disabled}
        aria-label={props.object.fmFieldName}
        defaultValue={props.options[0]}
        style={baseControlStyle}
      >
        {props.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (props.object.displayType === 'checkbox') {
    return (
      <label
        htmlFor={props.inputId}
        style={{
          ...baseControlStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}
      >
        <input id={props.inputId} type="checkbox" checked={disabled} disabled={disabled} readOnly />
        <span>{props.options[0]}</span>
      </label>
    );
  }

  if (props.object.displayType === 'radio') {
    return (
      <div
        role="radiogroup"
        aria-label={props.object.fmFieldName}
        style={{
          ...baseControlStyle,
          display: 'flex',
          flexDirection: 'column',
          gap: 4
        }}
      >
        {props.options.slice(0, 2).map((option, index) => (
          <label key={`${props.object.id}-${option}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <input
              type="radio"
              name={`radio-${props.object.id}`}
              checked={index === 0}
              disabled={disabled}
              readOnly
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    );
  }

  return (
    <input
      id={props.inputId}
      type={props.object.format === 'date' ? 'date' : 'text'}
      value={props.options[0]}
      readOnly
      aria-label={props.object.fmFieldName}
      style={baseControlStyle}
    />
  );
}

function getPreviewOptions(object: FieldLayoutObject, runtimeValue?: unknown): string[] {
  if (runtimeValue !== undefined && runtimeValue !== null) {
    if (Array.isArray(runtimeValue)) {
      const values = runtimeValue
        .map((item) => String(item))
        .filter((item) => item.trim().length > 0);
      if (values.length > 0) {
        return values;
      }
    }

    const asText = String(runtimeValue).trim();
    if (asText.length > 0) {
      return [asText];
    }
  }

  if (object.format === 'number') {
    return ['12,450.25', '98,000.00', '510.75'];
  }

  if (object.format === 'date') {
    return ['2026-03-03', '2026-03-10', '2026-03-17'];
  }

  return [object.fmFieldName, `${object.fmFieldName} A`, `${object.fmFieldName} B`];
}

function PortalControl(props: {
  style: React.CSSProperties;
  object: PortalLayoutObject;
  mode: 'designer' | 'runtime';
  runtimeData?: RuntimeLayoutData;
}): React.JSX.Element {
  const { object, style } = props;
  const runtimeRows = props.runtimeData?.portalRowsByObjectId?.[object.id];
  const rows = React.useMemo(() => {
    if (props.mode === 'runtime' && runtimeRows && runtimeRows.length > 0) {
      return runtimeRows;
    }

    return Array.from({ length: Math.max(1, object.rowCount) }).map((_, rowIndex) => {
      const row: Record<string, unknown> = {};
      for (const column of object.columns) {
        row[column.fmFieldName] = buildPortalMockValue(column.fmFieldName, rowIndex);
      }
      return row;
    });
  }, [object.columns, object.rowCount, props.mode, runtimeRows]);

  const rowHeight = 32;
  const headerHeight = 34;
  const viewportHeight = Math.max(0, object.height - headerHeight);
  const shouldVirtualize = props.mode === 'runtime' && rows.length > 40;
  const [scrollTop, setScrollTop] = React.useState(0);

  const visibleRange = React.useMemo(() => {
    if (!shouldVirtualize) {
      return {
        start: 0,
        end: rows.length
      };
    }

    return computePortalVisibleRange(rows.length, viewportHeight, rowHeight, scrollTop);
  }, [rows.length, rowHeight, scrollTop, shouldVirtualize, viewportHeight]);

  const visibleRows = rows.slice(visibleRange.start, visibleRange.end);
  const topSpacerHeight = shouldVirtualize ? visibleRange.start * rowHeight : 0;
  const bottomSpacerHeight = shouldVirtualize ? Math.max(0, (rows.length - visibleRange.end) * rowHeight) : 0;

  return (
    <div
      style={{
        ...style,
        border: '1px solid #9fb0c3',
        borderRadius: 6,
        overflow: 'hidden',
        background: '#ffffff'
      }}
      data-fm-portal-id={object.id}
    >
      <div style={{ display: 'grid', gridTemplateColumns: buildColumnWidths(object), background: '#edf3f8' }}>
        {object.columns.map((column) => (
          <div key={column.id} style={{ padding: '6px 8px', borderRight: '1px solid #d2dce6', fontWeight: 600 }}>
            {column.label}
          </div>
        ))}
        {object.columns.length === 0 ? (
          <div style={{ padding: '6px 8px', fontWeight: 600, color: '#60788e' }}>Drop fields to create columns</div>
        ) : null}
      </div>
      <div
        style={{
          overflowY: shouldVirtualize ? 'auto' : 'hidden',
          maxHeight: viewportHeight > 0 ? viewportHeight : undefined
        }}
        onScroll={(event) => {
          if (!shouldVirtualize) {
            return;
          }

          const target = event.currentTarget;
          setScrollTop(target.scrollTop);
        }}
      >
        {topSpacerHeight > 0 ? <div style={{ height: topSpacerHeight }} /> : null}
        {visibleRows.map((row, index) => {
          const rowIndex = visibleRange.start + index;
          return (
            <div
              key={`${object.id}-${rowIndex}`}
              data-fm-portal-row={rowIndex}
              style={{
                display: 'grid',
                gridTemplateColumns: buildColumnWidths(object),
                borderTop: '1px solid #ecf1f6',
                minHeight: rowHeight
              }}
            >
              {object.columns.map((column) => (
                <div
                  key={`${column.id}-${rowIndex}`}
                  data-fm-portal-cell={`${column.fmFieldName}:${rowIndex}`}
                  style={{ padding: '6px 8px', borderRight: '1px solid #f0f4f8' }}
                >
                  {formatPortalCellValue(row[column.fmFieldName], column.fmFieldName, rowIndex)}
                </div>
              ))}
              {object.columns.length === 0 ? (
                <div style={{ padding: '6px 8px', color: '#7a8e9f' }}>No columns configured</div>
              ) : null}
            </div>
          );
        })}
        {bottomSpacerHeight > 0 ? <div style={{ height: bottomSpacerHeight }} /> : null}
      </div>
    </div>
  );
}

function formatPortalCellValue(value: unknown, fieldName: string, rowIndex: number): string {
  if (value === undefined || value === null || value === '') {
    return buildPortalMockValue(fieldName, rowIndex);
  }

  return String(value);
}

function buildColumnWidths(object: PortalLayoutObject): string {
  if (object.columns.length === 0) {
    return '1fr';
  }

  return object.columns.map((column) => `${column.width}px`).join(' ');
}

function buildPortalMockValue(fieldName: string, rowIndex: number): string {
  const lower = fieldName.toLowerCase();
  const offset = rowIndex + 1;

  if (lower.includes('date')) {
    return `2026-03-${String(Math.min(28, offset)).padStart(2, '0')}`;
  }

  if (lower.includes('amount') || lower.includes('total') || lower.includes('price')) {
    return `${(offset * 1250.75).toFixed(2)}`;
  }

  return `${fieldName} ${offset}`;
}

export function computePortalVisibleRange(
  rowCount: number,
  viewportHeight: number,
  rowHeight: number,
  scrollTop: number,
  overscan = 3
): { start: number; end: number } {
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight) + overscan * 2);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rowCount, start + visibleCount);
  return {
    start,
    end
  };
}

export function applyAnchoredRuntimeRect(
  object: LayoutObject,
  layout: LayoutDefinition,
  viewport: RuntimeLayoutData['viewport']
): LayoutObject {
  if (!viewport) {
    return object;
  }

  const deltaWidth = viewport.width - layout.canvas.width;
  const deltaHeight = viewport.height - layout.canvas.height;
  if (deltaWidth === 0 && deltaHeight === 0) {
    return object;
  }

  const anchors = object.anchors;

  let x = object.x;
  let y = object.y;
  let width = object.width;
  let height = object.height;

  if (anchors.left && anchors.right) {
    width = Math.max(1, object.width + deltaWidth);
  } else if (anchors.right && !anchors.left) {
    x = object.x + deltaWidth;
  } else if (!anchors.left && !anchors.right) {
    x = object.x + deltaWidth / 2;
  }

  if (anchors.top && anchors.bottom) {
    height = Math.max(1, object.height + deltaHeight);
  } else if (anchors.bottom && !anchors.top) {
    y = object.y + deltaHeight;
  } else if (!anchors.top && !anchors.bottom) {
    y = object.y + deltaHeight / 2;
  }

  return {
    ...object,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  };
}
