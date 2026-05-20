import { readFileSync } from 'fs';
import { resolve } from 'path';

import { describe, expect, it } from 'vitest';

/**
 * These tests guard the structural contract between the wizard HTML template
 * (connectionWizard/index.ts) and the wizard UI script (connectionWizard/ui/index.js).
 *
 * Background: a previous regression removed the wrapping <form id="wizardForm">
 * from the HTML, but the script still called document.getElementById('wizardForm')
 * and addEventListener on the result. That null-deref halted execution of the
 * IIFE before Save/Test/message listeners ever bound, silently breaking the
 * entire wizard. The unit-test surface that snapshots HTML didn't catch it
 * because nothing asserted the element existed; the JS surface was never
 * exercised against a real DOM.
 *
 * Read the source files directly — they're small, stable, and this avoids the
 * heavy mock setup needed to instantiate the panel.
 */
const wizardHtmlSourcePath = resolve(__dirname, '../../../src/webviews/connectionWizard/index.ts');
const wizardJsPath = resolve(__dirname, '../../../src/webviews/connectionWizard/ui/index.js');

const wizardHtmlSource = readFileSync(wizardHtmlSourcePath, 'utf8');
const wizardJsSource = readFileSync(wizardJsPath, 'utf8');

describe('Connection wizard HTML/JS structural contract', () => {
  it('HTML template emits a <form id="wizardForm"> element', () => {
    // The form id is what the UI script looks up. Without this, input/change/submit
    // listeners cannot install and the wizard breaks silently.
    expect(wizardHtmlSource).toMatch(/<form[^>]*\sid="wizardForm"/);
  });

  it('HTML template closes the form with </form>', () => {
    // Without the close tag the HTML is malformed and the form contents leak
    // into siblings. (Belt-and-braces — the open tag asserts above.)
    expect(wizardHtmlSource).toMatch(/<\/form>/);
  });

  it('every <button> in the wizard HTML uses type="button"', () => {
    // Default <button> inside a <form> is type="submit". The wizard relies on
    // every button being type="button" so Save/Test never trigger a form
    // submission (which would reload the webview). Strip HTML comments first
    // so a literal "<button>" inside a doc comment doesn't trip the check.
    //
    // We loop the comment strip until the result is stable. CodeQL flags a
    // single-pass non-greedy replace as "incomplete multi-character
    // sanitization" because an adversarial input like `<!--<!---->` would
    // leave a trailing `<!--`. We don't actually face adversarial input here
    // (the source file is our own .ts template), but iterating to a fixed
    // point both silences the alert and makes the function robust if anyone
    // ever points it at less-controlled HTML.
    let withoutComments = wizardHtmlSource;
    for (let i = 0; i < 4; i += 1) {
      const stripped = withoutComments.replace(/<!--[\s\S]*?-->/g, '');
      if (stripped === withoutComments) break;
      withoutComments = stripped;
    }
    const buttonOpens = withoutComments.match(/<button\b[^>]*>/g) ?? [];
    expect(buttonOpens.length).toBeGreaterThan(0);
    for (const tag of buttonOpens) {
      expect(tag, `button tag missing type="button": ${tag}`).toMatch(/type="button"/);
    }
  });

  it('UI script installs delegated listeners on wizardForm', () => {
    // The bug we're guarding against: form null-deref. The script must look up
    // the form AND attach the input/change handlers that drive the stale-test
    // badge. If a future refactor renames the id, this test fires.
    expect(wizardJsSource).toMatch(/getElementById\(['"]wizardForm['"]\)/);
    expect(wizardJsSource).toMatch(/form\.addEventListener\(['"]input['"]/);
    expect(wizardJsSource).toMatch(/form\.addEventListener\(['"]change['"]/);
  });

  it('UI script suppresses form submission via preventDefault', () => {
    // Enter inside any <input> would otherwise submit the form and reload the
    // webview. The CSP blocks inline onsubmit, so the script must intercept.
    expect(wizardJsSource).toMatch(/form\.addEventListener\(['"]submit['"]/);
    expect(wizardJsSource).toMatch(/preventDefault\(\)/);
  });

  it('UI script falls back to document.body when wizardForm is missing', () => {
    // Defense in depth — if the form id is ever removed again, the rest of the
    // script (Save/Test/message handlers, ready postMessage) still binds
    // instead of halting on a null-deref. This keeps the wizard partially
    // functional until the HTML side is fixed.
    expect(wizardJsSource).toMatch(/document\.getElementById\(['"]wizardForm['"]\)\s*\|\|\s*document\.body/);
  });
});
