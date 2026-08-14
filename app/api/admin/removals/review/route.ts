import { withOrganizer, adminJson } from '@/lib/auth/organizer';
import { listRemovals, setRemovalStatus } from '@/lib/blobs/removals';

export const dynamic = 'force-dynamic';

/**
 * Marks removal requests reviewed or dismissed. Supports one record or all
 * pending records in a single operation.
 *
 * This NEVER changes visibility. A reviewed request leaves its media hidden;
 * restoring is a separate, deliberate action.
 */
export const POST = withOrganizer(async (req) => {
  const form = await req.formData().catch(() => null);
  const raw = form?.get('status');
  const status = raw === 'DISMISSED' ? 'DISMISSED' : raw === 'REVIEWED' ? 'REVIEWED' : null;
  if (!status) return adminJson({ error: 'INVALID' }, 400);

  const recordId = form?.get('recordId');
  const all = form?.get('all') === 'true';

  if (all) {
    const pending = (await listRemovals()).filter((r) => r.status === 'PENDING');
    for (const r of pending) await setRemovalStatus(r.recordId, status);
  } else if (typeof recordId === 'string' && recordId.length > 0) {
    await setRemovalStatus(recordId, status);
  } else {
    return adminJson({ error: 'INVALID' }, 400);
  }

  return new Response(null, {
    status: 303,
    headers: { location: '/admin', 'cache-control': 'private, no-store' },
  });
});
