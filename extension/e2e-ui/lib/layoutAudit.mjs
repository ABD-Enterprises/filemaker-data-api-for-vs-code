// Finds clipped, overlapping and unreachable elements in a webview document (runs inside the frame).
export const AUDIT_SCRIPT = () => {
  const issues = [];
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const vh = doc.clientHeight;
  const desc = (el) => {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${t ? ` "${t}"` : ''}`;
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const scrollerOf = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return p; } return null; };
  if (doc.scrollWidth > vw + 1) issues.push({ type: 'page-horizontal-scroll', where: `document ${doc.scrollWidth}px wide in a ${vw}px viewport` });
  const interactive = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=tab], [role=button]')].filter(visible);
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      const sc = scrollerOf(el);
      issues.push({ type: sc ? 'needs-horizontal-scroll-to-reach' : 'off-screen-control', where: `${desc(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}` });
    }
  }
  for (const el of document.querySelectorAll('button, [role=tab], summary, label, th, h1, h2, td, a')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const clipped = (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 2;
    const tab = el.matches('button, [role=tab], summary, label, th, h1, h2');
    if (clipped && tab) issues.push({ type: 'truncated-label', where: `${desc(el)} (${el.scrollWidth}px of text in ${el.clientWidth}px)` });
  }
  for (const t of document.querySelectorAll('table')) {
    if (!visible(t)) continue;
    const p = t.parentElement;
    if (t.scrollWidth > (p?.clientWidth ?? vw) + 2 && !scrollerOf(t) && getComputedStyle(p).overflowX === 'visible') issues.push({ type: 'table-without-scroll', where: `${desc(t)} ${t.scrollWidth}px in ${p?.clientWidth}px` });
  }
  const boxes = interactive.map((el) => ({ el, r: el.getBoundingClientRect() }));
  let overlaps = 0;
  for (let i = 0; i < boxes.length && overlaps < 6; i += 1) for (let j = i + 1; j < boxes.length && overlaps < 6; j += 1) {
    const a = boxes[i]; const b = boxes[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 4 && h > 4) { overlaps += 1; issues.push({ type: 'overlap', where: `${desc(a.el)} over ${desc(b.el)} (${Math.round(w)}x${Math.round(h)}px)` }); }
  }
  // buttons too small to hit
  for (const el of interactive) { const r = el.getBoundingClientRect(); if ((r.width < 16 || r.height < 16) && !/checkbox|radio/.test(el.type || '')) issues.push({ type: 'tiny-control', where: `${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}` }); }
  return { vw, vh, count: interactive.length, issues: issues.slice(0, 25) };
};
