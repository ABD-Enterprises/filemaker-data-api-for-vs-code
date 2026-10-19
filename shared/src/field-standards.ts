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
  if (['checkbox', 'checkboxset', 'radio', 'radiobuttongroup'].includes(display)) {
    const count = Number.isFinite(field.optionCount) ? Math.max(1, Math.ceil(field.optionCount!)) : 1;
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
