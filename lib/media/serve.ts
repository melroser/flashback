// The ONLY module permitted to import the media store.
// Enforced by an ESLint no-restricted-imports zone.

import { archiveId } from '../config/env';
import { mediaKey } from '../blobs/keys';
import { mediaStore } from '../blobs/media';
import type { GateProof } from '../auth/gate';
import { clampRange, parseRange, servableFromHead, HEAD_BYTES } from './range';

/**
 * Media byte responses are `private, max-age=60`.
 *
 * `private` forbids CDN and every shared cache, which is the actual security
 * requirement. `max-age=60` permits only the requesting attendee's own browser.
 *
 * This is a deliberate, bounded tradeoff. `no-store` would mean every revisit and
 * every video seek re-downloads through a function, and Netlify Free is
 * credit-metered — exhausting credits pauses the whole site. The cost of the
 * window: an item hidden or deleted can remain viewable for up to 60 seconds to
 * someone who already fetched it. Archive-level controls (disable, expiry) are
 * unaffected because they gate NEW requests.
 */
function headers(contentType: string, extra: Record<string, string> = {}): Headers {
  const h = new Headers({
    'content-type': contentType,
    'cache-control': 'private, max-age=60',
    vary: 'Cookie',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  return h;
}

function unavailable(): Response {
  return new Response(JSON.stringify({ error: 'UNAVAILABLE' }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

/**
 * Netlify Blobs has NO server-side range read: `get` returns stream / arrayBuffer
 * / blob / text / json, with no byte offset. Every partial response is therefore
 * produced by fetching an object and slicing locally, which is why the cases below
 * are shaped the way they are.
 */
export async function serveMedia(
  proof: GateProof,
  rangeHeader: string | null,
  method: 'GET' | 'HEAD' = 'GET',
): Promise<Response> {
  const meta = proof.entry.variants[proof.variant];
  if (!meta) return unavailable();

  const store = mediaStore();
  const key = mediaKey(archiveId(), proof.mediaId, proof.variant);
  const size = meta.byteLength;
  const isVideo = proof.entry.type === 'video' && proof.variant === 'full';

  const base: Record<string, string> = {};
  if (isVideo) base['accept-ranges'] = 'bytes';

  if (method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: headers(meta.contentType, { ...base, 'content-length': String(size) }),
    });
  }

  const parsed = parseRange(rangeHeader, size);

  // CASE: unsatisfiable start.
  if (parsed === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: headers(meta.contentType, { ...base, 'content-range': `bytes */${size}` }),
    });
  }

  // CASE 1: no usable Range -> stream the whole object.
  if (parsed === null) {
    const stream = (await store.get(key, { type: 'stream' })) as ReadableStream | null;
    if (!stream) return unavailable();
    return new Response(stream, {
      status: 200,
      headers: headers(meta.contentType, { ...base, 'content-length': String(size) }),
    });
  }

  // CASE 2: `bytes=0-` (what browsers send on initial video load). Satisfy in
  // full as a 206 by streaming. Treating it as a real partial read would mean
  // fetching 18MB to hand back 4MB. Seeking still works because a real seek
  // sends a bounded range.
  if (parsed.openEnded && parsed.start === 0) {
    const stream = (await store.get(key, { type: 'stream' })) as ReadableStream | null;
    if (!stream) return unavailable();
    return new Response(stream, {
      status: 206,
      headers: headers(meta.contentType, {
        ...base,
        'content-length': String(size),
        'content-range': `bytes 0-${size - 1}/${size}`,
      }),
    });
  }

  const { start, end } = clampRange(parsed);
  const length = end - start + 1;

  // CASE 3: small bounded range near the front of a video.
  //
  // Safari and iOS issue tiny probes such as `bytes=0-1` before deciding how to
  // proceed. Without this case that probe would pull the entire 18MB blob to
  // return 2 bytes. Because ffmpeg writes with `+faststart`, the moov atom is at
  // the front, so a stored 256KB `head` object satisfies these cheaply and also
  // speeds up initial metadata parsing.
  if (isVideo && servableFromHead({ start, end }) && proof.entry.variants.head) {
    const headKey = mediaKey(archiveId(), proof.mediaId, 'head');
    const buf = (await store.get(headKey, { type: 'arrayBuffer' })) as ArrayBuffer | null;
    if (buf && buf.byteLength >= Math.min(HEAD_BYTES, end + 1)) {
      const slice = buf.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: headers(meta.contentType, {
          ...base,
          'content-length': String(slice.byteLength),
          // Content-Range describes the FULL object, never the head length.
          // Getting this wrong breaks seeking.
          'content-range': `bytes ${start}-${start + slice.byteLength - 1}/${size}`,
        }),
      });
    }
  }

  // CASE 4: bounded range -> fetch and slice.
  const buf = (await store.get(key, { type: 'arrayBuffer' })) as ArrayBuffer | null;
  if (!buf) return unavailable();
  if (buf.byteLength !== size) {
    // Truncated or half-written blob. Never return a corrupt partial.
    return unavailable();
  }
  const slice = buf.slice(start, start + length);
  return new Response(slice, {
    status: 206,
    headers: headers(meta.contentType, {
      ...base,
      'content-length': String(slice.byteLength),
      'content-range': `bytes ${start}-${start + slice.byteLength - 1}/${size}`,
    }),
  });
}

/** Read full bytes for inlining into gated HTML (grid thumbnails). */
export async function readVariantBase64(
  proof: GateProof,
): Promise<{ dataUri: string } | null> {
  const meta = proof.entry.variants[proof.variant];
  if (!meta) return null;
  const store = mediaStore();
  const key = mediaKey(archiveId(), proof.mediaId, proof.variant);
  const buf = (await store.get(key, { type: 'arrayBuffer' })) as ArrayBuffer | null;
  if (!buf) return null;
  const b64 = Buffer.from(buf).toString('base64');
  return { dataUri: `data:${meta.contentType};base64,${b64}` };
}

/** Bulk-read grid thumbnails for inlining. Parallel, since each is ~20-30KB. */
export async function readGridDataUris(
  proofs: GateProof[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    proofs.map(async (p) => {
      const r = await readVariantBase64(p);
      if (r) out.set(p.mediaId, r.dataUri);
    }),
  );
  return out;
}
