import { archiveId } from '../config/env';
import { metaStore, readIndex, readVisibility } from './meta';
import { visKey, visSummaryKey } from './keys';
import type { Visibility, VisSummary } from './types';

/**
 * Visibility lives in one tiny document PER Media_Item, not in a shared index.
 *
 * Netlify Blobs has no compare-and-swap and no conditional write; overlapping
 * writes are last-write-wins. On a shared document, an Organizer hiding QLK 012
 * while a removal request hides QLK 031 would silently lose one of the two. A
 * lost write here is a lost *hide* — media staying visible after someone asked
 * for it to come down. Disjoint keys make those writes non-interfering by
 * construction.
 */
export async function setVisibility(
  mediaId: string,
  patch: { hidden?: boolean; deleted?: boolean },
  reason: Visibility['reason'],
): Promise<Visibility> {
  const prev = await readVisibility(mediaId);
  const next: Visibility = {
    schema: 1,
    mediaId,
    hidden: patch.hidden ?? prev?.hidden ?? false,
    deleted: patch.deleted ?? prev?.deleted ?? false,
    rev: (prev?.rev ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    reason,
  };
  await metaStore().setJSON(visKey(archiveId(), mediaId), next);
  return next;
}

export async function readAllVisibility(): Promise<Map<string, Visibility>> {
  const index = await readIndex();
  const out = new Map<string, Visibility>();
  if (!index) return out;
  await Promise.all(
    index.entries.map(async (e) => {
      const v = await readVisibility(e.mediaId);
      out.set(
        e.mediaId,
        v ?? {
          schema: 1,
          mediaId: e.mediaId,
          hidden: false,
          deleted: false,
          rev: 0,
          updatedAt: e.ingestedAt,
          reason: 'INGEST',
        },
      );
    }),
  );
  return out;
}

/**
 * Denormalized list used to render the grid without one read per item. This IS a
 * shared document and so does have a lost-update window — acceptable only because
 * it is display-only and self-healing: it is rebuilt after every mutation and on
 * every Admin_View load. The gate never consults it.
 */
export async function rebuildVisSummary(): Promise<VisSummary> {
  const all = await readAllVisibility();
  const summary: VisSummary = {
    schema: 1,
    hiddenIds: [...all.values()].filter((v) => v.hidden).map((v) => v.mediaId),
    deletedIds: [...all.values()].filter((v) => v.deleted).map((v) => v.mediaId),
    builtAt: new Date().toISOString(),
  };
  await metaStore().setJSON(visSummaryKey(archiveId()), summary);
  return summary;
}
