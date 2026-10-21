import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';

describe.skipIf(!JSDOM)('schema diff field types', () => {
  it('shows result type and kind separately in both views', () => {
    const html = '<div class="container"><header></header><section>' + ['meta', 'summary', 'exportButton', 'sideBySideMode', 'treeMode', 'changesOnly', 'sideBySidePanel', 'treePanel', 'sideBySide', 'tree'].map((id) => `<div id="${id}"></div>`).join('') + '</section></div>';
    const { document, send } = loadPage(html, 'window.requestAnimationFrame = (callback) => callback();\n' + readFileSync(path.resolve(__dirname, '../../../src/webviews/schemaDiff/ui/index.js'), 'utf8'));
    send({ type: 'diff', payload: { layout: 'Contacts', added: [{ name: 'Amount', type: 'normal', result: 'number', maxRepeat: 2 }], removed: [], changed: [], unchanged: [], summary: { added: 1, removed: 0, changed: 0 } } });
    expect(document.getElementById('sideBySide')?.textContent).toContain('TypenumberKindnormalReps2');
    document.getElementById('treeMode')!.click();
    expect(document.getElementById('tree')?.textContent).toContain('number');
    expect(document.getElementById('tree')?.textContent).toContain('Kind: normal');
  });
});
