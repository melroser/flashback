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
      /**
       * A browser navigation must never be answered with a raw JSON body.
       *
       * The admin controls are plain `method="post"` forms, so the response IS the
       * page. An organizer whose 12-hour session lapsed clicked a button and got
       * `{"error":"FORBIDDEN"}` rendered as the entire document, with no link back
       * and no explanation. The privilege decision was right; the presentation was
       * a dead end.
       *
       * Send anything that asked for HTML to the sign-in form, and keep the JSON
       * bodies for API clients and the deployment checks that assert on them.
       */
      if ((req.headers.get('accept') ?? '').includes('text/html')) {
        return new Response(null, {
          status: 303,
          headers: { location: '/admin?expired=1', 'cache-control': 'private, no-store' },
        });
      }

      const att = await verifyToken(
        sessionKey(),
        readCookie(cookies, ATTENDEE_COOKIE),
        'attendee',
      );
      // An attendee session is a recognised identity with insufficient privilege.
      if (att) return json({ error: 'FORBIDDEN' }, 403);
      return json({ error: 'UNAUTHORIZED' }, 401);
    }

    // CSRF.
    //
    // The primary guard is SameSite=Strict on fb_o: a cross-site POST cannot carry
    // the cookie at all, so it fails as unauthenticated before reaching here. The
    // Origin comparison is defence in depth.
    //
    // An ABSENT Origin is therefore allowed. Safari and some Chromium-based
    // browsers omit Origin on same-origin form submissions, and rejecting that
    // broke every button on the admin page in those browsers. A PRESENT Origin
    // must still match exactly, so a genuine cross-site attempt is still refused.
    //
    // The literal string `null` counts as absent, not as a mismatch. We serve
    // `Referrer-Policy: no-referrer` per Requirement 12.3, and under that policy
    // Chrome sends `Origin: null` on a same-origin form navigation. Comparing that
    // against the site origin failed, so EVERY admin button returned FORBIDDEN in
    // Chrome — the same class of bug the paragraph above describes, reintroduced
    // through a different header. An opaque origin cannot be trusted as a match, so
    // it is treated as no evidence either way and SameSite carries the decision.
    const expected = siteOrigin();
    const rawOrigin = req.headers.get('origin');
    const origin = rawOrigin && rawOrigin !== 'null' ? rawOrigin : null;
    if (expected && origin) {
      const normalise = (u: string) => u.replace(/\/$/, '').toLowerCase();
      if (normalise(origin) !== normalise(expected)) {
        return json({ error: 'FORBIDDEN' }, 403);
      }
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
