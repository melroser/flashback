import { archiveId } from '../config/env';
import { metaStore } from './meta';
import { removalKey, removalPrefix } from './keys';
import type { RemovalRecord } from './types';

/**
 * Lists removal records. At ~40 media items and a handful of requests a prefix
 * scan is cheaper and simpler than maintaining a reverse index, and it has no
 * lost-update surface. If this archive ever held thousands of items, the answer
 * would be a per-item pointer document, not a bigger scan.
 */
export async function listRemovals(): Promise<RemovalRecord[]> {
  const store = metaStore();
  const prefix = removalPrefix(archiveId());
  const out: RemovalRecord[] = [];
  try {
    const { blobs } = await store.list({ prefix });
    await Promise.all(
      blobs.map(async (b) => {
        const rec = (await store.get(b.key, { type: 'json' })) as RemovalRecord | null;
        if (rec) out.push(rec);
      }),
    );
  } catch {
    return [];
  }
  return out.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

export async function pendingByMediaId(): Promise<Map<string, RemovalRecord[]>> {
  const all = await listRemovals();
  const map = new Map<string, RemovalRecord[]>();
  for (const r of all) {
    if (r.status !== 'PENDING') continue;
    const list = map.get(r.mediaId) ?? [];
    list.push(r);
    map.set(r.mediaId, list);
  }
  return map;
}

export async function setRemovalStatus(
  recordId: string,
  status: 'REVIEWED' | 'DISMISSED',
): Promise<void> {
  const store = metaStore();
  const key = removalKey(archiveId(), recordId);
  const rec = (await store.get(key, { type: 'json' })) as RemovalRecord | null;
  if (!rec) return;
  // Review NEVER touches visibility. Restoring is a separate, deliberate action.
  await store.setJSON(key, { ...rec, status, reviewedAt: new Date().toISOString() });
}
