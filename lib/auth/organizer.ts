import { organizerSecret, sessionKey, siteOrigin } from '../config/env';
import { ORGANIZER_COOKIE, ATTENDEE_COOKIE, readCookie } from '../session/cookies';
import { verifyToken } from '../session/token';
import { ensureSeeded } from '../blobs/seed';
import type { ArchiveConfig } from '../blobs/types';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

export async function isOrganizer(req: Request): Promise<boolean> {
  const t = readCookie(req.headers.get('cookie'), ORGANIZER_COOKIE);
  return (await verifyToken(sessionKey(), t, 'organizer')) !== null;
}

/**
 * Wrapper for every state-changing organizer operation.
 *
 * Order: organizer session -> reject attendee-only -> Origin check -> then and
 * only then does the handler body run. No handler body runs, and therefore no
 * write occurs, unless all of it passes.
 *
 * Organizer privileges derive exclusively from a valid organizer session. A
 * leaked attendee code can never disable, delete, or rotate anything.
 */
export function withOrganizer(
  handler: (req: Request, ctx: { config: ArchiveConfig }) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const cookies = req.headers.get('cookie');

    const org = await verifyToken(
      sessionKey(),
      readCookie(cookies, ORGANIZER_COOKIE),
      'organizer',
    );

    if (!org) {
      const att = await verifyToken(
        sessionKey(),
        readCookie(cookies, ATTENDEE_COOKIE),
        'attendee',
      );
      // An attendee session is a recognised identity with insufficient privilege.
      if (att) return json({ error: 'FORBIDDEN' }, 403);
      return json({ error: 'UNAUTHORIZED' }, 401);
    }

    // CSRF: reject a mismatched Origin, and reject an absent one on a
    // state-changing request.
    const expected = siteOrigin();
    const origin = req.headers.get('origin');
    if (expected) {
      if (!origin || origin !== expected) return json({ error: 'FORBIDDEN' }, 403);
    }

    // Guard against the secret being unset in production.
    try {
      organizerSecret();
    } catch {
      return json({ error: 'UNAVAILABLE' }, 503);
    }

    const config = await ensureSeeded();
    return handler(req, { config });
  };
}

export { json as adminJson };
