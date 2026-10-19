// Finds clipped, overlapping and unreachable elements in a webview document (runs inside the frame).
export const AUDIT_SCRIPT = () => {
  const issues = [];
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const vh = doc.clientHeight;
  const desc = (el) => {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${t ? ` "${t}"` : ''}`;
  };
  const visible = (el) => {
    // The content of a closed <details> is not shown (the browser keeps its boxes, so the size alone is no proof).
    const closed = el.closest('details:not([open])');
    if (closed && !(el.tagName === 'SUMMARY' && el.parentElement === closed)) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const scrollerOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return p;
    }
    return null;
  };
  // Root cause first: a <select> wider than the panel (a very long option text widens it) pushes the whole
  // page sideways. Report that once, then constrain such selects and audit the rest of the page without it.
  const rootCauses = [];
  let hasLongOption = false;
  for (const sel of document.querySelectorAll('select')) {
    const longest = [...sel.options].reduce((m, o) => (o.text.length > m.length ? o.text : m), '');
    if (longest.length > 60) hasLongOption = true;
    if (!visible(sel)) continue;
    const w = sel.getBoundingClientRect().width;
    if (w > vw + 1)
      rootCauses.push({
        type: 'select-widened-by-long-option',
        where: `${desc(sel)} is ${Math.round(w)}px wide in a ${vw}px panel; longest option has ${longest.length} characters`
      });
  }
  // Audit the rest of the page as if those selects were capped to the panel (the cap is refreshed per call).
  if (hasLongOption) {
    // CSSOM edits are allowed under the webview's CSP (an injected <style> element is not).
    for (const sel of document.querySelectorAll('select')) {
      sel.style.setProperty('max-width', `${Math.max(120, Math.floor(vw * 0.5))}px`, 'important');
      sel.style.setProperty('min-width', '0', 'important');
    }
  }
  if (doc.scrollWidth > vw + 1)
    issues.push({
      type: 'page-horizontal-scroll',
      where: `document ${doc.scrollWidth}px wide in a ${vw}px viewport`
    });
  const interactive = [
    ...document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=tab], [role=button]'
    )
  ].filter(visible);
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      // A control inside a designed scroller (a wide results table, a code block) is reachable by scrolling.
      if (scrollerOf(el)) continue;
      issues.push({
        type: 'off-screen-control',
        where: `${desc(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`
      });
    }
  }
  for (const el of document.querySelectorAll(
    'button, [role=tab], summary, label, th, h1, h2, td, a'
  )) {
    if (!visible(el)) continue;
    // Text that is visually hidden on purpose (a heading for screen readers) is 1px by design.
    if (el.closest('.visually-hidden')) continue;
    const cs = getComputedStyle(el);
    // An ellipsis on a table cell or a header with a title attribute is a design choice; text cut off
    // silently (overflow hidden without an ellipsis) or an ellipsis on a button or tab is not.
    const ellipsis = cs.textOverflow === 'ellipsis';
    const designed = ellipsis && (el.matches('th, td') || el.hasAttribute('title'));
    const clipped =
      (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || ellipsis) &&
      el.scrollWidth > el.clientWidth + 2 &&
      !designed;
    const tab = el.matches('button, [role=tab], summary, label, h1, h2');
    if (clipped && tab)
      issues.push({
        type: 'truncated-label',
        where: `${desc(el)} (${el.scrollWidth}px of text in ${el.clientWidth}px)`
      });
  }
  for (const t of document.querySelectorAll('table')) {
    if (!visible(t)) continue;
    const p = t.parentElement;
    if (
      t.scrollWidth > (p?.clientWidth ?? vw) + 2 &&
      !scrollerOf(t) &&
      getComputedStyle(p).overflowX === 'visible'
    )
      issues.push({
        type: 'table-without-scroll',
        where: `${desc(t)} ${t.scrollWidth}px in ${p?.clientWidth}px`
      });
  }
  // Overlap counts only when one control actually covers the centre of another (it cannot be clicked),
  // not when their bounding boxes merely intersect.
  let overlaps = 0;
  for (const el of interactive) {
    if (overlaps >= 6) break;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
    const top = document.elementFromPoint(cx, cy);
    if (
      top &&
      !el.contains(top) &&
      !top.contains(el) &&
      interactive.some((o) => o !== el && o.contains(top))
    ) {
      overlaps += 1;
      issues.push({ type: 'covered-control', where: `${desc(el)} is covered by ${desc(top)}` });
    }
  }
  // buttons too small to hit
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if ((r.width < 16 || r.height < 16) && !/checkbox|radio/.test(el.type || ''))
      issues.push({
        type: 'tiny-control',
        where: `${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`
      });
  }
  return { vw, vh, count: interactive.length, rootCauses, issues: issues.slice(0, 25) };
};
