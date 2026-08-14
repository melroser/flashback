import { getStore, type Store } from '@netlify/blobs';
import { archiveId } from '../config/env';
import { configKey, indexKey, visKey } from './keys';
import type { ArchiveConfig, MediaIndex, Visibility } from './types';

/**
 * Safety-relevant state. Created with STRONG consistency so that every read of
 * archive state, expiration, the code hash, and per-item visibility observes the
 * most recent write.
 *
 * This is deliberately a property of the store rather than something each call
 * site must remember to ask for. Netlify Blobs defaults to eventual consistency
 * with up to ~60s propagation, which would mean DISABLE ARCHIVE — the single most
 * important control in the product — could lag by a minute.
 */
let _meta: Store | null = null;
export function metaStore(): Store {
  if (_meta) return _meta;
  _meta = getStore({ name: 'flashback-meta', consistency: 'strong' });
  return _meta;
}

/** Test seam. */
export function __setMetaStore(s: Store | null) {
  _meta = s;
}

export async function readConfig(): Promise<ArchiveConfig | null> {
  return (await metaStore().get(configKey(archiveId()), { type: 'json' })) as ArchiveConfig | null;
}

export async function writeConfig(c: ArchiveConfig): Promise<void> {
  await metaStore().setJSON(configKey(archiveId()), { ...c, updatedAt: new Date().toISOString() });
}

export async function readVisibility(mediaId: string): Promise<Visibility | null> {
  return (await metaStore().get(visKey(archiveId(), mediaId), {
    type: 'json',
  })) as Visibility | null;
}

// ---------------------------------------------------------------------------
// Media index, with a warm-instance cache.
//
// The index is written exactly once, by the Ingest_Script, and no runtime route
// ever mutates it. Because it is immutable between ingests it is safe to hold in
// module scope across warm invocations.
//
// HARD RULE: only immutable data is cached. `config` and `vis` are never cached,
// because a cached authorization decision is an authorization bypass. The TTL
// exists so a re-ingest is picked up without a redeploy.
// ---------------------------------------------------------------------------

const INDEX_TTL_MS = 60_000;
let _indexCache: { value: MediaIndex | null; at: number } | null = null;

export async function readIndex(): Promise<MediaIndex | null> {
  const now = Date.now();
  if (_indexCache && now - _indexCache.at < INDEX_TTL_MS) return _indexCache.value;
  const value = (await metaStore().get(indexKey(archiveId()), {
    type: 'json',
  })) as MediaIndex | null;
  _indexCache = { value, at: now };
  return value;
}

export async function writeIndex(i: MediaIndex): Promise<void> {
  await metaStore().setJSON(indexKey(archiveId()), i);
  _indexCache = null;
}

export function __clearIndexCache() {
  _indexCache = null;
}
