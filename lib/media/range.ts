export const RANGE_MAX_BYTES = 4 * 1024 * 1024; // 4MB
export const HEAD_BYTES = 256 * 1024; // 256KB, matches the ingest `head` variant

export type ParsedRange =
  | null // absent or syntactically invalid -> treat as absent, per RFC 9110
  | 'unsatisfiable'
  | { start: number; end: number; openEnded: boolean };

/**
 * Single ranges only. A multi-range header is answered with 200 and the whole
 * object, which is permitted and avoids implementing multipart/byteranges.
 */
export function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(.*)$/i.exec(header.trim());
  if (!m) return null; // non-`bytes` unit
  const spec = (m[1] ?? '').trim();
  if (spec.includes(',')) return null; // multi-range
  const dash = spec.indexOf('-');
  if (dash === -1) return null;

  const rawStart = spec.slice(0, dash).trim();
  const rawEnd = spec.slice(dash + 1).trim();

  if (rawStart === '') {
    // Suffix form: bytes=-500 -> last 500 bytes
    const n = Number(rawEnd);
    if (!Number.isInteger(n) || n <= 0) return null;
    const len = Math.min(n, size);
    return { start: size - len, end: size - 1, openEnded: false };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0) return null;
  if (start >= size) return 'unsatisfiable';

  if (rawEnd === '') {
    return { start, end: size - 1, openEnded: true };
  }

  const end = Number(rawEnd);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1), openEnded: false };
}

/** Clamp a satisfiable range so no single response approaches the payload cap. */
export function clampRange(r: { start: number; end: number }): { start: number; end: number } {
  const maxEnd = r.start + RANGE_MAX_BYTES - 1;
  return { start: r.start, end: Math.min(r.end, maxEnd) };
}

/** True when the whole range sits inside the stored `head` object. */
export function servableFromHead(r: { start: number; end: number }): boolean {
  return r.end < HEAD_BYTES;
}
