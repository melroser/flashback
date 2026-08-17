import { getStore, type Store } from '@netlify/blobs';
import { blobCreds } from '../config/env';

/**
 * Media bytes. Default (eventual) consistency is correct here because the
 * contents are immutable once written, and whether they may be served is decided
 * entirely by the strongly-consistent meta store.
 *
 * One consequence worth stating: deleting a media blob is eventually consistent,
 * so for a short window a regional read could still return bytes for a deleted
 * item. That cannot leak, because the gate reads the strongly-consistent
 * visibility document first and returns 404 before this handle is ever obtained.
 * Byte deletion is the second line of defense; the gate is the first.
 *
 * DO NOT IMPORT THIS MODULE except from lib/media/serve.ts and the ingest
 * script. That restriction is enforced by an ESLint import zone, so a bypass
 * fails the build rather than a code review.
 */
let _media: Store | null = null;
export function mediaStore(): Store {
  if (_media) return _media;
  _media = getStore({ name: 'flashback-media', ...blobCreds() });
  return _media;
}

export function __setMediaStore(s: Store | null) {
  _media = s;
}
