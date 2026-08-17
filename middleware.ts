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

const LOGIN_CSS = `
:root{--void:#080809;--tar:#111114;--ash:#1c1c21;--flash:#f5f3ee;--bone:#e8e5de;--smoke:#a8a29a;--uv:#7a3cff;--acid:#39ff6a;--siren:#ff2d2d}
*{box-sizing:border-box}
body{background:var(--void);color:var(--bone);margin:0;padding:2rem 1.25rem 3rem;
  font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-text-size-adjust:100%}
.wrap{max-width:26rem;margin:0 auto}
.kicker{font-size:.6875rem;letter-spacing:.28em;text-transform:uppercase;color:var(--smoke);margin:0}
h1{font-size:clamp(2.5rem,17vw,4rem);line-height:.85;letter-spacing:-.03em;text-transform:uppercase;
  margin:.35rem 0 0;color:var(--flash);
  text-shadow:-1px 0 0 rgba(45,225,255,.5),1px 0 0 rgba(255,45,45,.42)}
h2{font-size:1rem;letter-spacing:.02em;text-transform:uppercase;color:var(--smoke);margin:.4rem 0 0;font-weight:400}
.lede{margin:1.6rem 0 0;color:var(--bone)}
ul{list-style:none;padding:0;margin:1.5rem 0 0;border-top:1px solid var(--ash)}
li{padding:.85rem 0 .85rem 1.9rem;border-bottom:1px solid var(--ash);position:relative;color:var(--bone)}
li b{color:var(--flash);font-weight:600}
li:before{content:"";position:absolute;left:0;top:1.35rem;width:.6rem;height:.6rem;background:var(--uv)}
form{margin:2rem 0 0}
label{display:block;font-size:.6875rem;letter-spacing:.28em;text-transform:uppercase;color:var(--smoke)}
input{width:100%;margin-top:.6rem;padding:.9rem;background:var(--tar);color:var(--flash);
  border:1px solid var(--ash);font:inherit;letter-spacing:.06em}
input:focus{outline:2px solid var(--acid);outline-offset:2px;border-color:var(--uv)}
button{width:100%;margin-top:.75rem;padding:.95rem;background:transparent;color:var(--acid);
  border:1px solid rgba(57,255,106,.4);font:inherit;font-size:.6875rem;letter-spacing:.28em;
  text-transform:uppercase;cursor:pointer}
button:hover{background:var(--acid);color:var(--void)}
.err{margin:1rem 0 0;color:var(--siren)}
.fine{margin:1.75rem 0 0;font-size:.75rem;line-height:1.55;color:var(--smoke)}
.sig{margin:2.25rem 0 0;font-size:.6875rem;letter-spacing:.28em;text-transform:uppercase;color:var(--smoke)}
.sig a{color:var(--bone)}
`;

/**
 * The organizer sign-in screen.
 *
 * This is the FIRST thing an organizer sees, usually on a phone, from a link in a
 * DM, knowing nothing about any of this. A bare password box would read as
 * sketchy — which is the exact opposite of what this project needs to convey to
 * people who were right to be cautious about an unvetted photographer.
 *
 * So it answers, before asking for anything: what this is, why it is locked, why
 * it is not a Drive link, and what they control.
 */
function organizerLogin(
  status: 200 | 401 | 403,
  csp: string,
  who: string,
  event: string,
  origin: string,
): NextResponse {
  const denied =
    status === 403
      ? '<p class="err">That code opens the archive, not this page. You need the organizer key.</p>'
      : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>FLASHBACK — ${event}</title>
<meta name="description" content="Photographs from ${event}. A private archive, locked and built to disappear.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="FLASHBACK">
<meta property="og:title" content="FLASHBACK — ${event}">
<meta property="og:description" content="Photographs from the night, locked. Organizer access.">
<meta property="og:image" content="${origin}/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${origin}/og.jpg">
<style>${LOGIN_CSS}</style></head><body><div class="wrap">
<p class="kicker">Private archive &middot; organizers only</p>
<h1>Flashback</h1>
<h2>${event}</h2>

<p class="lede">${who} shot your night. Every photo is in here, locked. Nothing is public,
and nothing goes out until you decide it does.</p>

<ul>
  <li><b>It isn&rsquo;t a Drive link.</b> There&rsquo;s no public URL to leak, nothing in
  search results, and no copy sitting in someone&rsquo;s cloud forever.</li>
  <li><b>You hand out access, not him.</b> You get one code to send however you
  already reach people. He never sees your list.</li>
  <li><b>One tap kills it.</b> If anyone raises a concern, you shut the whole
  thing off instantly. No asking, no waiting.</li>
  <li><b>Anyone in a photo can pull it.</b> No name, no reason, no account. It
  hides the moment they ask.</li>
  <li><b>It expires on its own.</b> This was built to disappear, not to sit
  somewhere forever.</li>
</ul>

${denied}
<form method="post" action="/api/admin/session">
  <label for="secret">Organizer key</label>
  <input id="secret" type="password" name="secret" autocomplete="current-password"
    autocapitalize="off" spellcheck="false" placeholder="paste the key he sent you" autofocus>
  <button type="submit">Open the archive</button>
</form>

<p class="fine">Sent to more than one organizer on purpose &mdash; you all get the same
key, so any of you can review it or switch it off. If this link reached you by
mistake, there is nothing here to see.</p>

<p class="sig">Built with PLUR by <a href="https://film.fyi">film.fyi</a></p>
</div></body></html>`;

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
  const who = process.env.FLASHBACK_PHOTOGRAPHER ?? 'The photographer';
  const event = process.env.FLASHBACK_EVENT_NAME ?? 'QLICK QRAVE';
  // Netlify's edge runtime does not expose `URL`, and the proxied request origin
  // resolves to http, which link crawlers reject or downgrade. Force https:
  // everything here is served over TLS regardless.
  const origin = (
    process.env.FLASHBACK_SITE_ORIGIN ??
    process.env.URL ??
    req.nextUrl.origin
  ).replace(/^http:\/\//, 'https://');
  const { pathname } = req.nextUrl;

  if (pathname === '/admin') {
    if (!key) return organizerLogin(200, csp, who, event, origin);
    const org = await verifyToken(key, req.cookies.get(ORGANIZER_COOKIE)?.value, 'organizer');
    if (!org) {
      const att = await verifyToken(key, req.cookies.get(ATTENDEE_COOKIE)?.value, 'attendee');
      // 403 when a session exists but lacks privilege: that is a real "signed in,
      // still not allowed" signal.
      //
      // 200 when there is NO session, because this page is a login form and
      // discloses nothing. A 4xx here would stop link crawlers from rendering a
      // preview, and an organizer's first contact with this project is a link in a
      // DM — a bare URL with no card reads as untrustworthy, which is the opposite
      // of what this has to convey. The security boundary is /api/admin/*, which
      // still returns 401 and 403, and the page itself re-verifies before
      // rendering anything.
      return organizerLogin(att ? 403 : 200, csp, who, event, origin);
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
