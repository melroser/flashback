import { withOrganizer, adminJson } from '@/lib/auth/organizer';
import { writeConfig } from '@/lib/blobs/meta';

export const dynamic = 'force-dynamic';

export const POST = withOrganizer(async (req, { config }) => {
  const form = await req.formData().catch(() => null);
  const v = form?.get('expiresAt');
  if (typeof v !== 'string' || v.length === 0) return adminJson({ error: 'INVALID' }, 400);

  const t = Date.parse(v);
  if (Number.isNaN(t)) return adminJson({ error: 'INVALID' }, 400);

  // Past values are accepted on purpose: setting an expiry in the past is how the
  // Organizer ends the archive immediately without deleting anything.
  await writeConfig({ ...config, expiresAt: new Date(t).toISOString() });

  return new Response(null, {
    status: 303,
    headers: { location: '/admin', 'cache-control': 'private, no-store' },
  });
});
