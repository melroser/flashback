import { NextResponse, type NextRequest } from 'next/server';
import { verifyToken } from './lib/session/token';
import { ATTENDEE_COOKIE, ORGANIZER_COOKIE } from './lib/session/cookies';

/**
 * Middleware does three things: attach the per-request CSP with a fresh nonce,
 * and return the correct HTTP status for unauthenticated page requests (a Server
 * Component cannot set an arbitrary status without Next's experimental
 * authInterrupts, which is not a dependency worth taking).
 *
 * MIDDLEWARE IS NOT THE AUTHORIZATION BOUNDARY. It verifies only the cookie
 * SIGNATURE, which needs nothing but Web Crypto and the signing key. It never
 * reads Blobs and never checks archive state, expiration, code version, or
 * visibility. Those are enforced inside the route handler on every request, even
 * for a request middleware waved through.
 */
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    // data: is required for the inline SVG grain texture and for the base64 grid
    // thumbnails inlined into the gated archive HTML.
    "img-src 'self' data:",
    "media-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const LOGIN_STYLE =
  'body{background:#080809;color:#E8E5DE;font:15px/1.6 ui-monospace,Menlo,monospace;margin:0;padding:2rem}' +
  'input,button{font:inherit;background:#111114;color:#E8E5DE;border:1px solid #1C1C21;padding:.6rem}' +
  'button{color:#39FF6A;cursor:pointer}' +
  'h1{font-size:.7rem;letter-spacing:.28em;text-transform:uppercase;color:#A8A29A}';

function organizerLogin(status: 401 | 403, csp: string): NextResponse {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><title>FLASHBACK ADMIN</title>' +
    '<style>' +
    LOGIN_STYLE +
    '</style></head><body>' +
    '<h1>Flashback / organizer</h1>' +
    '<form method="post" action="/api/admin/session">' +
    '<p><input type="password" name="secret" placeholder="organizer secret" autocomplete="current-password" autofocus></p>' +
    '<p><button type="submit">Enter</button></p>' +
    '</form></body></html>';

  return new NextResponse(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'content-security-policy': csp,
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export async function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const key = process.env.FLASHBACK_SESSION_KEY;
  const { pathname } = req.nextUrl;

  if (pathname === '/admin') {
    if (!key) return organizerLogin(401, csp);
    const org = await verifyToken(key, req.cookies.get(ORGANIZER_COOKIE)?.value, 'organizer');
    if (!org) {
      const att = await verifyToken(key, req.cookies.get(ATTENDEE_COOKIE)?.value, 'attendee');
      // An attendee session is a recognised identity with insufficient privilege.
      return organizerLogin(att ? 403 : 401, csp);
    }
  }

  if (pathname === '/archive' && key) {
    const org = await verifyToken(key, req.cookies.get(ORGANIZER_COOKIE)?.value, 'organizer');
    const att = await verifyToken(key, req.cookies.get(ATTENDEE_COOKIE)?.value, 'attendee');
    if (!org && !att) {
      return NextResponse.redirect(new URL('/', req.url), 307);
    }
  }

  // The nonce must be set on the FORWARDED REQUEST as well as the response. Next
  // reads it out of the request CSP header to stamp its own bootstrap and Flight
  // scripts; skipping this half is how nonce CSP silently breaks in production.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('content-security-policy', csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('content-security-policy', csp);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
