import { organizerSecret, sessionKey, SESSION_TTL_SECONDS } from '@/lib/config/env';
import { mintToken, timingSafeEqual } from '@/lib/session/token';
import { ORGANIZER_COOKIE, serializeSessionCookie } from '@/lib/session/cookies';
import { checkRate, recordHit, tooManyRequests } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const rate = await checkRate(req, 'admin-login');
  if (rate.limited) return tooManyRequests();

  let submitted = '';
  const ct = req.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      const b = (await req.json()) as { secret?: unknown };
      submitted = typeof b.secret === 'string' ? b.secret : '';
    } else {
      const f = await req.formData();
      const v = f.get('secret');
      submitted = typeof v === 'string' ? v : '';
    }
  } catch {
    /* fallthrough to failure */
  }

  const enc = new TextEncoder();
  // Compared against the env value directly. The organizer secret is never
  // persisted to Blobs, so reaching the blob store cannot yield it.
  const ok =
    submitted.length > 0 &&
    timingSafeEqual(enc.encode(submitted), enc.encode(organizerSecret()));

  if (!ok) {
    await recordHit('admin-login', rate.hash);

    // A mistyped key came from a browser form, so the response IS the page. Sending
    // JSON put `{"error":"UNAUTHORIZED"}` on screen as the entire document with no
    // field to try again in. Return to the sign-in form and let it say so. API
    // clients, including the deployment verifier, still get the 401 body.
    if ((req.headers.get('accept') ?? '').includes('text/html')) {
      return new Response(null, {
        status: 303,
        headers: { location: '/admin?denied=1', 'cache-control': 'private, no-store' },
      });
    }

    return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    });
  }

  const token = await mintToken(sessionKey(), 'organizer', 0, SESSION_TTL_SECONDS);
  return new Response(null, {
    status: 303,
    headers: {
      location: '/admin',
      'set-cookie': serializeSessionCookie(ORGANIZER_COOKIE, token),
      'cache-control': 'private, no-store',
    },
  });
}
