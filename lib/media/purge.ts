// Byte deletion. Like serve.ts this is permitted to import the media store, and
// like serve.ts it is the only other module allowed to. Deletion is authorized by
// the organizer wrapper rather than by a GateProof, because it is an operator
// action rather than a read.

import { archiveId } from '../config/env';
import { mediaKey } from '../blobs/keys';
import { mediaStore } from '../blobs/media';
import type { MediaEntry, Variant } from '../blobs/types';

export async function deleteEntryBytes(entry: MediaEntry): Promise<number> {
  const store = mediaStore();
  let removed = 0;
  for (const variant of Object.keys(entry.variants) as Variant[]) {
    try {
      await store.delete(mediaKey(archiveId(), entry.mediaId, variant));
      removed++;
    } catch {
      // Item is already unreachable via the gate; the delete is retryable.
    }
  }
  return removed;
}
