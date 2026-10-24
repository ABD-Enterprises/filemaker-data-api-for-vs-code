import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('runtime frame sizing', () => {
  const css = readFileSync(new URL('../app/styles.css', import.meta.url), 'utf8');
  it('uses a shrinkable grid track and includes padding and borders in the frame width', () => {
    expect(css).toMatch(/\.runtime-layout-page\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.runtime-canvas-host\s*\{[^}]*box-sizing:\s*border-box/);
    expect(css).toMatch(/\.runtime-canvas-host\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.runtime-canvas-host\s*>\s*\[data-mode\s*=\s*["']runtime["']\]\s*\{[^}]*max-width:\s*100%/);
  });
});
