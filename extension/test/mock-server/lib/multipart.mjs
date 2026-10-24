// Minimal multipart/form-data parser (enough for the Data API container upload: one `upload` part).
export function parseMultipart(contentType, body) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const chunk = body.slice(start + 2, next - 2); // strip leading CRLF and trailing CRLF
    const headEnd = chunk.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = chunk.slice(0, headEnd).toString('utf8');
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1];
      parts.push({ name, filename, type, data: chunk.slice(headEnd + 4) });
    }
    pos = next;
  }
  return parts;
}
