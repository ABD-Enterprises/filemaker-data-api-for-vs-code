/** Dependency-free presentation rules shared by the designer and value-entry webviews. */
export const FIELD_LAYOUT = Object.freeze({
  grid: 8,
  pageMargin: 24,
  rowGap: 16,
  columnGap: 24,
  labelPosition: 'top' as const,
  labelSpace: 24,
  optionHeight: 24,
  textWidth: 240,
  numberWidth: 120,
  temporalWidth: 160,
  inputHeight: 34,
  multilineHeight: 96,
  containerHeight: 160
});

export interface StandardFieldMetadata {
  name: string;
  type?: string;
  displayType?: string;
  multiline?: boolean;
  optionCount?: number;
}

export function standardFieldSize(field: Partial<StandardFieldMetadata> = {}): { width: number; height: number } {
  const type = (field.type ?? '').toLowerCase();
  const display = (field.displayType ?? '').toLowerCase().replace(/[ -]/g, '');
  if (['checkbox', 'checkboxset', 'radio', 'radiobuttongroup', 'radiobuttons'].includes(display)) {
    const count = Number.isFinite(field.optionCount) ? Math.min(50, Math.max(1, Math.ceil(field.optionCount!))) : 1;
    return { width: FIELD_LAYOUT.textWidth, height: Math.max(FIELD_LAYOUT.inputHeight, count * FIELD_LAYOUT.optionHeight) };
  }
  if (type === 'container') {
    return { width: FIELD_LAYOUT.textWidth, height: FIELD_LAYOUT.containerHeight };
  }
  if (field.multiline || ['longtext', 'multilinetext', 'multiline'].includes(type.replace(/[ -]/g, '')) || ['textarea', 'multiline'].includes(display)) {
    return { width: FIELD_LAYOUT.textWidth, height: FIELD_LAYOUT.multilineHeight };
  }
  return {
    width: type === 'number' ? FIELD_LAYOUT.numberWidth
      : ['date', 'time', 'timestamp'].includes(type) ? FIELD_LAYOUT.temporalWidth : FIELD_LAYOUT.textWidth,
    height: FIELD_LAYOUT.inputHeight
  };
}

/** Data attributes select build-generated CSS; webviews never need inline styles or relaxed CSP. */
export function applyStandardField(element: { setAttribute(name: string, value: string): void }, field: Partial<StandardFieldMetadata> = {}): void {
  const size = standardFieldSize(field);
  element.setAttribute('data-fm-width', String(size.width));
  element.setAttribute('data-fm-height', String(size.height));
  element.setAttribute('data-fm-label-position', FIELD_LAYOUT.labelPosition);
}

/** Build-time stylesheet shared by classic-script webviews and generated runtime pages. */
export function standardFieldsCss(): string {
  const widths = new Set([FIELD_LAYOUT.textWidth, FIELD_LAYOUT.numberWidth, FIELD_LAYOUT.temporalWidth]);
  const heights = new Set([FIELD_LAYOUT.inputHeight, FIELD_LAYOUT.multilineHeight, FIELD_LAYOUT.containerHeight,
    ...Array.from({ length: 50 }, (_, i) => Math.max(FIELD_LAYOUT.inputHeight, (i + 1) * FIELD_LAYOUT.optionHeight))]);
  return `
:root { --fm-row-gap: ${FIELD_LAYOUT.rowGap}px; --fm-column-gap: ${FIELD_LAYOUT.columnGap}px; }
.fm-fields { display: flex; flex-wrap: wrap; align-items: flex-start; gap: ${FIELD_LAYOUT.rowGap}px ${FIELD_LAYOUT.columnGap}px; min-width: 0; }
.fm-field { display: flex; flex-direction: column; width: var(--fm-field-width); max-width: 100%; min-width: 0; box-sizing: border-box; }
.fm-field-label { display: block; min-height: ${FIELD_LAYOUT.labelSpace}px; overflow-wrap: anywhere; }
.fm-field > .fm-field-control { flex: none; }
.fm-field-control { display: block; width: 100%; max-width: 100%; min-width: 0; height: var(--fm-field-height); min-height: var(--fm-field-height); box-sizing: border-box; }
.fm-field-table { display: block; width: 100%; min-width: 0; }
.fm-field-table > thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.fm-field-table > tbody > tr > td { display: block; border: 0; padding: 0; max-width: 100%; min-width: 0; }
.fm-field-table > tbody > tr > td.fm-field-control { padding: 8px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
${[...widths].map((width) => `[data-fm-width="${width}"] { --fm-field-width: ${width}px; }`).join('\n')}
${[...heights].map((height) => `[data-fm-height="${height}"] { --fm-field-height: ${height}px; }`).join('\n')}
@media (max-width: 640px) {
  .fm-fields { flex-direction: column; }
}
`;
}
