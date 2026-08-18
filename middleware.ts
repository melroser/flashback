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
body{background:var(--void);color:var(--bone);margin:0;padding:2.5rem 1.25rem 3rem;
  font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-text-size-adjust:100%}
.wrap{max-width:25rem;margin:0 auto}
.kicker{font-size:.625rem;letter-spacing:.26em;text-transform:uppercase;color:var(--smoke);margin:0}
h1{font-size:clamp(2.75rem,18vw,4.25rem);line-height:.85;letter-spacing:-.03em;text-transform:uppercase;
  margin:.5rem 0 0;color:var(--flash);
  text-shadow:-1px 0 0 rgba(45,225,255,.5),1px 0 0 rgba(255,45,45,.42)}
h2{font-size:.95rem;letter-spacing:.16em;text-transform:uppercase;color:var(--smoke);
  margin:.5rem 0 0;font-weight:400}
.lede{margin:1.75rem 0 0;color:var(--bone)}
form{margin:1.75rem 0 0}
label{display:block;font-size:.625rem;letter-spacing:.26em;text-transform:uppercase;color:var(--smoke)}
input{width:100%;margin-top:.55rem;padding:.9rem;background:var(--tar);color:var(--flash);
  border:1px solid var(--ash);font:inherit;letter-spacing:.06em}
input:focus{outline:2px solid var(--acid);outline-offset:2px;border-color:var(--uv)}
button{width:100%;margin-top:.7rem;padding:.95rem;background:transparent;color:var(--acid);
  border:1px solid rgba(57,255,106,.4);font:inherit;font-size:.625rem;letter-spacing:.26em;
  text-transform:uppercase;cursor:pointer}
button:hover{background:var(--acid);color:var(--void)}
.err{margin:1.25rem 0 0;padding:.7rem .8rem;border-left:2px solid var(--siren);
  background:var(--tar);color:var(--bone);font-size:.85rem}
details{margin:0;border-top:1px solid var(--ash);padding:1rem 0}
details+details{border-top:1px solid var(--ash)}
.faq{margin-top:2rem}
summary{cursor:pointer;list-style:none;font-size:.625rem;letter-spacing:.26em;
  text-transform:uppercase;color:var(--smoke)}
summary::-webkit-details-marker{display:none}
summary:before{content:"+ ";color:var(--uv)}
details[open] summary:before{content:"\\2212 "}
details p{margin:.9rem 0 0;font-size:.85rem;line-height:1.6;color:var(--smoke)}
details b{color:var(--flash);font-weight:600}
.warn{color:var(--siren)}
.sig{margin:2.25rem 0 0;font-size:.625rem;letter-spacing:.26em;text-transform:uppercase;color:var(--smoke)}
.sig a{color:var(--bone)}
`;

/**
 * Organizer sign-in.
 *
 * Deliberately short. Opened on a phone, from a DM, by someone who did not ask for a
 * technical briefing: name the thing, say what the page is for, take the key.
 * Everything else is collapsed.
 *
 * The two-codes note is not optional detail. There are two secrets with very
 * different powers, they arrive by the same channel, and confusing them means
 * sending the kill switch to a whole guest list.
 */
function organizerLogin(
  status: 200 | 401 | 403,
  csp: string,
  event: string,
  origin: string,
  reason?: 'denied' | 'expired',
): NextResponse {
  // An attendee session here usually means they sensibly previewed the guest view
  // first. Say what to do next instead of scolding.
  const note =
    reason === 'denied'
      ? '<p class="err">That key didn&rsquo;t work. Check for a stray space and paste it again.</p>'
      : reason === 'expired'
        ? '<p class="err">Your session timed out. Paste the organizer key to pick up where you left off.</p>'
        : status === 403
          ? '<p class="err">You&rsquo;re signed in as an attendee. Paste the organizer key to manage the gallery.</p>'
          : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>FLASHBACK — ${event}</title>
<meta name="description" content="Private archive management portal for ${event}.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="FLASHBACK">
<meta property="og:title" content="FLASHBACK — ${event}">
<meta property="og:description" content="Private archive management portal.">
<meta property="og:image" content="${origin}/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${origin}/og.jpg">
<style>${LOGIN_CSS}</style></head><body><div class="wrap">

<p class="kicker">Private archive management portal</p>
<h1>Flashback</h1>
<h2>${event}</h2>

<p class="lede">This is where you manage your Flashback gallery.</p>

${note}
<form method="post" action="/api/admin/session">
  <label for="secret">Organizer key</label>
  <input id="secret" type="password" name="secret" autocomplete="current-password"
    autocapitalize="off" spellcheck="false" placeholder="paste your key" autofocus>
  <button type="submit">Open the gallery</button>
</form>

<div class="faq">
<details>
  <summary>What&rsquo;s a Flashback gallery?</summary>
  <p>A free, private photo share built for raves, with privacy and discretion in
  mind. From here you control who gets in, and you can hide or remove any image at
  any time. The whole gallery disappears on its own when the countdown ends.</p>
  <p>This is a prototype.</p>
</details>

<details>
  <summary>Don&rsquo;t get it twisted</summary>
  <p>2 codes for Flashback.</p>
  <p><b>Short one</b> &mdash; for sharing. Send it to people who were there.</p>
  <p><b>Long one</b> &mdash; for you only. It runs the gallery.</p>
  <p class="warn">Don&rsquo;t send the long one to guests. That one can delete
  everything.</p>
  <p>Swap the short one whenever you like &mdash; it signs out anyone still using the
  old one.</p>
</details>
</div>

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
    // Set by the sign-in and privilege guards when they bounce a browser back here,
    // so the form can explain itself instead of the user re-typing into silence.
    const sp = req.nextUrl.searchParams;
    const reason = sp.has('denied') ? 'denied' : sp.has('expired') ? 'expired' : undefined;

    if (!key) return organizerLogin(200, csp, event, origin, reason);
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
      return organizerLogin(att ? 403 : 200, csp, event, origin, reason);
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
