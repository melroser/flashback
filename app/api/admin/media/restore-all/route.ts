import { withOrganizer, adminJson } from '@/lib/auth/organizer';
import { readIndex } from '@/lib/blobs/meta';
import { readAllVisibility, setVisibility, rebuildVisSummary } from '@/lib/blobs/vis';
import { pendingByMediaId } from '@/lib/blobs/removals';

export const dynamic = 'force-dynamic';

/**
 * Bulk recovery. Two distinct operations behind one endpoint.
 *
 * Why this exists: removal requires no identity, is rate limited only per IP, and
 * every Media_ID is visible in the Archive_View. So a single attendee, or anyone
 * who obtains the shared code, can hide the entire archive in about two rate-limit
 * windows. Without a bulk restore the only recovery is clicking through every item
 * one at a time.
 *
 * That recovery need is also why this is NOT hard-blocked on pending requests. A
 * mass-hide attack creates one pending request per item, so refusing to act while
 * anything is pending would make the tool useless in precisely the scenario it
 * exists for.
 *
 * But naming the pending count inside a single confirmation was not enough. With
 * one confirmation covering both cases, the ordinary recovery keystroke also
 * re-exposed the people who explicitly asked to be taken down: the default failed
 * toward exposure, and a warning is not a substitute for a safe default. So the
 * two cases are now two operations with two different confirmation strings.
 *
 *   DEFAULT — confirm = `RESTORE <n> ITEMS`, n = hidden items with NO pending
 *   request. Restores exactly those. Anything somebody asked to have taken down
 *   stays hidden. This is the everyday path and it cannot expose a requester.
 *
 *   OVERRIDE — includePending=yes AND confirm = `RESTORE ALL INCLUDING <p>
 *   REQUESTED`, p = the held-back count. Restores everything, pending included.
 *   This is the mass-hide recovery path. Typing <p> is the whole point: you
 *   cannot reach this operation without stating how many requests you override.
 *
 * n is the safe number and p is the number that costs someone their privacy, so
 * neither confirmation string can be typed by accident in place of the other.
 *
 * Neither path touches review status. Overriding a request does not resolve it —
 * the record stays PENDING and keeps showing in the Admin_View as owed work.
 * Genuine requests should be dismissed or reviewed individually first.
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

  const hasPending = (mediaId: string) => (pending.get(mediaId) ?? []).length > 0;
  const restorable = hiddenEntries.filter((e) => !hasPending(e.mediaId));
  const heldBack = hiddenEntries.filter((e) => hasPending(e.mediaId));

  const form = await req.formData().catch(() => null);
  const confirm = form?.get('confirm');

  const confirmDefault = `RESTORE ${restorable.length} ITEMS`;
  const confirmIncludingPending = `RESTORE ALL INCLUDING ${heldBack.length} REQUESTED`;

  // The override is only a separate operation while something is actually held
  // back. With nothing pending both paths restore the identical set, so fall
  // through to the default rather than demanding a string reading "INCLUDING 0".
  const override = form?.get('includePending') === 'yes' && heldBack.length > 0;

  // Reported on every refusal so the caller can see both counts and both strings
  // without a second request.
  const counts = {
    hidden: hiddenEntries.length,
    restoredByDefault: restorable.length,
    heldBackWithPendingRequest: heldBack.length,
    confirmDefault,
    confirmIncludingPending: heldBack.length > 0 ? confirmIncludingPending : undefined,
  };

  // Nothing the default path could do. Saying so beats accepting a confirmation
  // and answering with a 303 that looks exactly like a successful restore.
  if (!override && restorable.length === 0) {
    return adminJson(
      {
        error: 'NOTHING_TO_RESTORE',
        message:
          hiddenEntries.length === 0
            ? 'Nothing is hidden, so there is nothing to restore.'
            : `All ${heldBack.length} hidden item(s) have a pending removal request, so restoring without overriding a request would change nothing. Review or dismiss those requests first, or resubmit with includePending=yes and confirm exactly: ${confirmIncludingPending}`,
        ...counts,
      },
      409,
    );
  }

  const expected = override ? confirmIncludingPending : confirmDefault;

  if (confirm !== expected) {
    return adminJson(
      {
        error: 'CONFIRM_REQUIRED',
        message: `Type exactly: ${expected}`,
        ...counts,
        note:
          heldBack.length > 0 && !override
            ? `${heldBack.length} hidden item(s) have a pending removal request and stay hidden on this path. To restore those too, send includePending=yes with confirm exactly: ${confirmIncludingPending}`
            : undefined,
      },
      400,
    );
  }

  const targets = override ? hiddenEntries : restorable;
  for (const entry of targets) {
    await setVisibility(entry.mediaId, { hidden: false }, 'ORGANIZER');
  }
  await rebuildVisSummary();

  return new Response(null, {
    status: 303,
    headers: { location: '/admin', 'cache-control': 'private, no-store' },
  });
});
