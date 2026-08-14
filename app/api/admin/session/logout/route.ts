import { ORGANIZER_COOKIE, clearSessionCookie } from '@/lib/session/cookies';

export const dynamic = 'force-dynamic';

export async function POST() {
  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': clearSessionCookie(ORGANIZER_COOKIE),
      'cache-control': 'private, no-store',
    },
  });
}
