import { ORGANIZER_COOKIE, clearSessionCookie } from '@/lib/session/cookies';

export const dynamic = 'force-dynamic';

export async function POST() {
  return new Response(null, {
    status: 303,
    headers: {
      // Back to the organizer sign-in, NOT '/', which is the attendee code screen.
      // Logging out of the admin portal and landing on a guest prompt is
      // disorienting and looks like the app broke.
      location: '/admin',
      'set-cookie': clearSessionCookie(ORGANIZER_COOKIE),
      'cache-control': 'private, no-store',
    },
  });
}
