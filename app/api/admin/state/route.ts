import { withOrganizer, adminJson } from '@/lib/auth/organizer';
import { writeConfig } from '@/lib/blobs/meta';

export const dynamic = 'force-dynamic';

export const POST = withOrganizer(async (req, { config }) => {
  const form = await req.formData().catch(() => null);
  const raw = form?.get('state');
  const state = raw === 'DISABLED' ? 'DISABLED' : raw === 'LIVE' ? 'LIVE' : null;
  if (!state) return adminJson({ error: 'INVALID' }, 400);

  // Written to the strongly-consistent store, so the next Media_API read observes
  // it immediately. This is the most important control in the product.
  await writeConfig({ ...config, state });

  return new Response(null, {
    status: 303,
    headers: { location: '/admin', 'cache-control': 'private, no-store' },
  });
});
