import { withOrganizer, adminJson } from '@/lib/auth/organizer';
import { readIndex } from '@/lib/blobs/meta';
import { setVisibility, rebuildVisSummary } from '@/lib/blobs/vis';
import { deleteEntryBytes } from '@/lib/media/purge';

export const dynamic = 'force-dynamic';

export const POST = withOrganizer(async (req) => {
  const index = await readIndex();
  const entries = index?.entries ?? [];

  const form = await req.formData().catch(() => null);
  const confirm = form?.get('confirm');
  const expected = `DELETE ALL ${entries.length} ITEMS`;

  if (confirm !== expected) {
    return adminJson(
      { error: 'CONFIRM_REQUIRED', message: `Type exactly: ${expected}` },
      400,
    );
  }

  // Sequential and idempotent on retry. ~40 items x up to 4 variants is well
  // inside the 60s synchronous execution budget.
  const results: Array<{ label: string; removed: number }> = [];
  for (const entry of entries) {
    await setVisibility(entry.mediaId, { hidden: true, deleted: true }, 'ORGANIZER');
    const removed = await deleteEntryBytes(entry);
    results.push({ label: entry.label, removed });
  }
  await rebuildVisSummary();

  return adminJson({ ok: true, deleted: results.length, results }, 200);
});
