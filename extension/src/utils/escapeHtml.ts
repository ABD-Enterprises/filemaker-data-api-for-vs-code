/** Escape text for HTML. Restore pages historically leave single quotes unchanged. */
export function escapeHtml(value: unknown, escapeSingleQuotes = true): string {
  const escaped = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escapeSingleQuotes ? escaped.replace(/'/g, '&#39;') : escaped;
}
