/**
 * `.` and `..` are not usable as one path segment of a request: encodeURIComponent leaves dots alone, and
 * the URL parser then resolves the segment away (`.../layouts/L/script/..` becomes `.../layouts/L/`, a
 * different request that reports success). A layout, script or field called `.` or `..` is refused before
 * anything is sent.
 */
export function isDotSegment(name: string): boolean {
  return name === '.' || name === '..';
}

/** The message for a layout, script or field name that is `.` or `..`. */
export function dotSegmentMessage(kind: string, name: string): string {
  return `The ${kind} name "${name}" cannot be used in a request (a web address treats it as a folder reference). Rename it in FileMaker.`;
}
