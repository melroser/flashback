import { withOrganizer, adminJson } from '@/lib/auth/organizer';
import { readIndex } from '@/lib/blobs/meta';
import { setVisibility, rebuildVisSummary } from '@/lib/blobs/vis';
import { deleteEntryBytes } from '@/lib/media/purge';

export const dynamic = 'force-dynamic';

export const POST = withOrganizer(async (req) => {
  const url = new URL(req.url);
  const mediaId = url.pathname.split('/').at(-2) ?? '';

  const index = await readIndex();
  const entry = index?.entries.find((e) => e.mediaId === mediaId);
  if (!entry) return adminJson({ error: 'NOT_FOUND' }, 404);

  const form = await req.formData().catch(() => null);
  const confirm = form?.get('confirm');
  const expected = `DELETE ${entry.label}`;

  // The confirmation check runs BEFORE the media store handle is ever obtained, so
  // a failed confirmation cannot partially delete. Exact match; wrong case fails.
  if (confirm !== expected) {
    return adminJson(
      { error: 'CONFIRM_REQUIRED', message: `Type exactly: ${expected}` },
      400,
    );
  }

  // Mark deleted FIRST. That is immediately effective against the gate, so the
  // item is already unreachable. If byte removal then fails, the delete is
  // retryable and nothing was exposed in the meantime.
  await setVisibility(entry.mediaId, { hidden: true, deleted: true }, 'ORGANIZER');
  await deleteEntryBytes(entry);
  await rebuildVisSummary();

  return new Response(null, {
    status: 303,
    headers: { location: '/admin', 'cache-control': 'private, no-store' },
  });
});
