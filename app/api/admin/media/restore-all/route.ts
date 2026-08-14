import { withOrganizer, adminJson } from '@/lib/auth/organizer';
import { readIndex } from '@/lib/blobs/meta';
import { readAllVisibility, setVisibility, rebuildVisSummary } from '@/lib/blobs/vis';
import { pendingByMediaId } from '@/lib/blobs/removals';

export const dynamic = 'force-dynamic';

/**
 * Bulk recovery.
 *
 * Why this exists: removal requires no identity, is rate limited only per IP, and
 * every Media_ID is visible in the Archive_View. So a single attendee, or anyone
 * who obtains the shared code, can hide the entire archive in about two rate-limit
 * windows. Without a bulk restore the only recovery is clicking through every item
 * one at a time.
 *
 * This is deliberately NOT hard-blocked on pending requests. A mass-hide attack
 * creates a pending request per item, so blocking on pending would make the
 * recovery tool useless in precisely the scenario it exists for. Instead the
 * confirmation names how many pending requests this would override, so the choice
 * is informed rather than silent. Genuine requests should be dismissed or reviewed
 * individually first.
 */
export const POST = withOrganizer(async (req) => {
  const index = await readIndex();
  const entries = index?.entries ?? [];
  const vis = await readAllVisibility();
  const pending = await pendingByMediaId();

  const hiddenEntries = entries.filter((e) => {
    const v = vis.get(e.mediaId);
    return v?.hidden && !v.deleted;
  });

  const pendingCount = hiddenEntries.filter((e) => (pending.get(e.mediaId) ?? []).length > 0).length;

  const form = await req.formData().catch(() => null);
  const expected = `RESTORE ${hiddenEntries.length} ITEMS`;

  if (form?.get('confirm') !== expected) {
    return adminJson(
      {
        error: 'CONFIRM_REQUIRED',
        message: `Type exactly: ${expected}`,
        hidden: hiddenEntries.length,
        withPendingRemovalRequests: pendingCount,
        warning:
          pendingCount > 0
            ? `${pendingCount} of these have a pending removal request. Restoring makes them visible to attendees again.`
            : undefined,
      },
      400,
    );
  }

  for (const entry of hiddenEntries) {
    await setVisibility(entry.mediaId, { hidden: false }, 'ORGANIZER');
  }
  await rebuildVisSummary();

  return new Response(null, {
    status: 303,
    headers: { location: '/admin', 'cache-control': 'private, no-store' },
  });
});
