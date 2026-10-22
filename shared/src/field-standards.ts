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

/** Field geometry for all clients. Opt into extension page chrome when building a webview. */
export function standardFieldsCss(webview = false): string {
  const widths = new Set([FIELD_LAYOUT.textWidth, FIELD_LAYOUT.numberWidth, FIELD_LAYOUT.temporalWidth]);
  const heights = new Set([FIELD_LAYOUT.inputHeight, FIELD_LAYOUT.multilineHeight, FIELD_LAYOUT.containerHeight,
    ...Array.from({ length: 50 }, (_, i) => Math.max(FIELD_LAYOUT.inputHeight, (i + 1) * FIELD_LAYOUT.optionHeight))]);
  return (webview ? webviewBaseCss() : '') + `
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

/** Extension chrome only: generated FM Web pages keep their own page styling. */
function webviewBaseCss(): string {
  return `
:root {
  --fm-page-width: 1200px;
  --fm-control-radius: 4px;
  --fm-panel-radius: 8px;
  --fm-panel-padding: 16px;
  --bg: var(--vscode-editor-background, #ffffff);
  --panel: var(--vscode-editorWidget-background, #f3f3f3);
  --text: var(--vscode-foreground, #333333);
  --muted: color-mix(in srgb, var(--vscode-descriptionForeground, var(--vscode-foreground, #333333)) 75%, var(--vscode-foreground, #333333));
  --border: var(--vscode-contrastBorder, var(--vscode-panel-border, #cccccc));
  --accent: var(--vscode-button-background, #007acc);
  --accent-text: var(--vscode-button-foreground, #ffffff);
  --accent-strong: var(--vscode-button-hoverBackground, #0062a3);
  --secondary: var(--vscode-button-secondaryBackground, var(--bg));
  --secondary-text: var(--vscode-button-secondaryForeground, var(--text));
  --secondary-hover: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground, var(--bg)));
  --success: var(--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, var(--vscode-foreground, #333333))));
  --error: var(--vscode-errorForeground, #a1260d);
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); color: var(--text); background: var(--bg); line-height: 1.4; }
.container, .wrap, .fm-page, .app-shell { width: 100%; max-width: var(--fm-page-width); margin: 0; padding: 16px; min-width: 0; }
h1 { margin: 0 0 8px; font-size: 1.6em; font-weight: 600; }
h2 { margin: 0 0 12px; font-size: 1.2em; font-weight: 600; }
h3 { font-size: 1.05em; }
.panel, .card, .form-section, .pane, .center-pane, .console-pane, .builder-panel, .fm-panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--fm-panel-radius); padding: var(--fm-panel-padding); min-width: 0; }
input, select, textarea { font: inherit; border: 1px solid var(--border); border-color: var(--vscode-contrastBorder, var(--vscode-input-border, var(--border))); border-radius: var(--fm-control-radius); padding: 8px 10px; min-width: 0; background: var(--vscode-input-background, #ffffff); color: var(--vscode-input-foreground, var(--text)); accent-color: var(--vscode-focusBorder, #007acc); }
code, pre, .fm-code { font-family: var(--vscode-editor-font-family, monospace); }
input:disabled, select:disabled, textarea:disabled, [readonly], .fm-readonly { background: var(--vscode-input-background, #ffffff); background: color-mix(in srgb, var(--vscode-input-background, #ffffff) 85%, var(--bg)); color: var(--vscode-disabledForeground, var(--muted)); resize: none; }
button, summary.secondary, details.menu > summary { font: inherit; font-weight: 500; border: 1px solid var(--vscode-contrastBorder, transparent); border-radius: var(--fm-control-radius); background: var(--accent); color: var(--accent-text); padding: 5px 12px; cursor: pointer; }
.actions > button, .actions > details > summary { min-height: 32px; }
button:hover:not(:disabled) { background: var(--accent-strong); }
button.secondary, summary.secondary, details.menu > summary, .mode-switch button, .mode-toggle button, .tool-grid button, .object-list button, .action-row button, .field-chip, .inspector-field button, .portal-column-actions button, .portal-field-chip { background: var(--secondary); color: var(--secondary-text); }
button.secondary:hover:not(:disabled), summary.secondary:hover, details.menu > summary:hover, .mode-switch button:hover, .mode-toggle button:hover { background: var(--secondary-hover); }
.mode-switch button.active, .mode-toggle button.active { border-color: var(--vscode-focusBorder, #007acc); font-weight: 600; }
button.small { padding: 2px 8px; min-height: 0; }
button.link, button.icon { background: none; color: var(--vscode-textLink-foreground, #005fb8); padding: 0 4px; min-height: 0; }
button.link:hover:not(:disabled), button.icon:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, var(--panel)); }
button.link.danger { color: var(--error); }
button:disabled { opacity: 0.5; cursor: default; }
button, summary { outline: 1px solid var(--vscode-contrastBorder, transparent); }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, #007acc)); outline-offset: 1px; }
input::placeholder, textarea::placeholder { color: color-mix(in srgb, var(--vscode-input-placeholderForeground, color-mix(in srgb, var(--vscode-input-foreground, var(--text)) 75%, var(--vscode-input-background, var(--bg)))) 20%, var(--vscode-input-foreground, var(--text))); opacity: 1; }
.fm-banner, .status.success, .status.error, .status.warning, .status.info, .summary.error, .template-banner, .restricted-notice, .legacy-tls-warning, .conflict { border: 1px solid var(--vscode-contrastBorder, var(--vscode-inputValidation-infoBorder, var(--border))); border-radius: var(--fm-panel-radius); padding: 10px; margin: 12px 0; background: var(--vscode-inputValidation-infoBackground, var(--panel)); color: var(--vscode-inputValidation-infoForeground, var(--text)); overflow-wrap: anywhere; }
.fm-banner.error, .status.error, .summary.error, .conflict { background: var(--vscode-inputValidation-errorBackground, var(--panel)); color: var(--vscode-inputValidation-errorForeground, var(--text)); border-color: var(--vscode-contrastBorder, var(--vscode-inputValidation-errorBorder, var(--error))); }
.fm-banner.warning, .status.warning, .restricted-notice, .legacy-tls-warning { background: var(--vscode-inputValidation-warningBackground, var(--panel)); color: var(--vscode-inputValidation-warningForeground, var(--text)); border-color: var(--vscode-contrastBorder, var(--vscode-inputValidation-warningBorder, var(--border))); }
.fm-banner.success, .status.success { background: color-mix(in srgb, var(--success) 12%, var(--bg)); color: var(--text); border-color: var(--vscode-contrastBorder, var(--success)); }
.fm-banner:empty, .status:empty, .summary:empty { display: none; }
table { width: 100%; border-collapse: collapse; font: inherit; }
th, td { border: 1px solid var(--border); padding: 8px; text-align: left; vertical-align: top; }
th { font-weight: 600; background: var(--panel); }
a:any-link { color: var(--vscode-textLink-foreground, #005fb8); }
a:hover { text-decoration: underline; }
`;
}
