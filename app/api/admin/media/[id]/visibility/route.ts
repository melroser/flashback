import { withOrganizer, adminJson } from '@/lib/auth/organizer';
import { readIndex } from '@/lib/blobs/meta';
import { setVisibility, rebuildVisSummary } from '@/lib/blobs/vis';
import { pendingByMediaId } from '@/lib/blobs/removals';

export const dynamic = 'force-dynamic';

export const POST = withOrganizer(async (req) => {
  const url = new URL(req.url);
  const mediaId = url.pathname.split('/').at(-2) ?? '';

  const form = await req.formData().catch(() => null);
  const hidden = form?.get('hidden') === 'true';

  const index = await readIndex();
  const entry = index?.entries.find((e) => e.mediaId === mediaId);
  if (!entry) return adminJson({ error: 'NOT_FOUND' }, 404);

  // Un-hiding something that somebody specifically asked to have taken down needs
  // a deliberate confirmation naming the request. Visibility and review status are
  // separate documents, so without this an Organizer working through the grid
  // could silently reverse a removal request.
  if (!hidden) {
    const pending = (await pendingByMediaId()).get(mediaId) ?? [];
    if (pending.length > 0 && form?.get('confirmPending') !== 'yes') {
      return adminJson(
        {
          error: 'PENDING_REMOVAL',
          message: `${entry.label} has ${pending.length} pending removal request(s). Review or dismiss them first, or resubmit with confirmPending=yes.`,
          pending: pending.map((p) => ({ recordId: p.recordId, submittedAt: p.submittedAt })),
        },
        409,
      );
    }
  }

  // Bytes are retained on hide. Hide is reversible; delete is not.
  await setVisibility(entry.mediaId, { hidden }, 'ORGANIZER');
  await rebuildVisSummary();

  return new Response(null, {
    status: 303,
    headers: { location: '/admin', 'cache-control': 'private, no-store' },
  });
});
