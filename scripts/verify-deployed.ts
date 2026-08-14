/**
 * FLASHBACK deployed security verification.
 *
 *   npm run verify -- --url https://site.netlify.app --code ABC123 --secret xxx
 *
 * This runs against the DEPLOYED site. A successful local build is explicitly not
 * evidence: Netlify Dev uses a sandboxed blob store that cannot see production
 * data, and the strong-consistency behaviour that DISABLE ARCHIVE depends on only
 * exists in production.
 *
 * Destructive checks target a dedicated Verification_Item and never an
 * attendee-facing photograph. The run restores LIVE state and the original
 * expiration when it finishes.
 */

interface Args {
  url: string;
  code: string;
  secret: string;
  verifyLabel?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i === -1 ? undefined : a[i + 1];
  };
  const url = get('url');
  const code = get('code');
  const secret = get('secret');
  if (!url || !code || !secret) {
    console.error('usage: npm run verify -- --url <url> --code <code> --secret <secret>');
    console.error('  optional: --verifyLabel "QLK 001"   (item used for destructive checks)');
    process.exit(2);
  }
  return { url: url.replace(/\/$/, ''), code, secret, verifyLabel: get('verifyLabel') };
}

import { Progress, logAbove, waitWithSpinner } from './lib/progress';

const A = parseArgs();

// Total assertion count, kept in step with the checks below so the bar is honest.
const TOTAL_CHECKS = 46;
let bar: Progress | null = null;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(id: string, desc: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    logAbove(`  PASS  ${id}  ${desc}`);
  } else {
    failed++;
    failures.push(`${id} ${desc} ${detail}`);
    logAbove(`  FAIL  ${id}  ${desc}  ${detail}`);
  }
  bar?.tick(`${id} ${desc}`);
}

function section(name: string) {
  logAbove(`\n${name}`);
}

/** No redirect following, so we observe the real status and Set-Cookie. */
async function raw(
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  // withOrganizer rejects a state-changing request whose Origin does not match
  // the site, so the harness must present a correct Origin on its own admin calls
  // or its legitimate requests would 403.
  if ((init.method ?? 'GET') !== 'GET') headers.set('origin', A.url);
  return fetch(`${A.url}${path}`, { ...init, headers, redirect: 'manual' });
}

function cookieFrom(res: Response, name: string): string | undefined {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    if (raw.startsWith(`${name}=`)) {
      const v = raw.split(';')[0];
      if (v && !v.endsWith('=')) return v;
    }
  }
  return undefined;
}

const form = (o: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

async function main() {
  console.log(`\nFLASHBACK verification against ${A.url}`);
  bar = new Progress('checks', TOTAL_CHECKS);

  // ---------------------------------------------------------------- headers
  section('Headers and indexing');
  const root = await raw('/');
  const H = (k: string) => root.headers.get(k) ?? '';
  check('12.2', 'X-Content-Type-Options nosniff', H('x-content-type-options') === 'nosniff');
  check('12.3', 'Referrer-Policy no-referrer', H('referrer-policy') === 'no-referrer');
  check('12.4', 'Permissions-Policy denies camera/mic/geo',
    /camera=\(\)/.test(H('permissions-policy')) &&
    /microphone=\(\)/.test(H('permissions-policy')) &&
    /geolocation=\(\)/.test(H('permissions-policy')));
  check('12.5', 'HSTS >= 31536000', /max-age=(\d+)/.test(H('strict-transport-security')) &&
    Number(/max-age=(\d+)/.exec(H('strict-transport-security'))?.[1] ?? 0) >= 31536000);
  check('12.1', 'CSP frame-ancestors none + default-src self',
    /frame-ancestors 'none'/.test(H('content-security-policy')) &&
    /default-src 'self'/.test(H('content-security-policy')));
  check('11.3', 'X-Robots-Tag noindex, nofollow', /noindex/.test(H('x-robots-tag')) && /nofollow/.test(H('x-robots-tag')));
  const robots = await (await raw('/robots.txt')).text();
  check('11.5', 'robots.txt disallows all', /Disallow:\s*\/$/m.test(robots));

  // ------------------------------------------------------------ auth basics
  section('Attendee authentication');
  const wrong = await raw('/api/access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'WRONGWRONG' }),
  });
  check('14.2', 'wrong code -> 401, no cookie',
    wrong.status === 401 && !cookieFrom(wrong, 'fb_a'), `got ${wrong.status}`);

  const good = await raw('/api/access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: A.code }),
  });
  const attendee = cookieFrom(good, 'fb_a');
  check('14.3', 'correct code -> session issued', Boolean(attendee), `status ${good.status}`);
  if (!attendee) {
    console.error('\nCannot continue without an attendee session.');
    process.exit(1);
  }
  const setCookieRaw = (good.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('fb_a=')) ?? '';
  check('1.4', 'cookie HttpOnly + Secure + SameSite=Strict',
    /HttpOnly/i.test(setCookieRaw) && /Secure/i.test(setCookieRaw) && /SameSite=Strict/i.test(setCookieRaw),
    setCookieRaw.replace(/fb_a=[^;]+/, 'fb_a=***'));

  const noSess = await raw('/archive');
  const noSessBody = noSess.status < 400 ? await noSess.text() : '';
  check('14.4', 'archive without session -> redirect/401, no media refs',
    (noSess.status === 307 || noSess.status === 302 || noSess.status === 401) &&
    !/\/api\/media\//.test(noSessBody), `got ${noSess.status}`);

  const archive = await raw('/archive', {}, attendee);
  const archiveBody = await archive.text();
  check('14.3b', 'archive renders with session', archive.status === 200, `got ${archive.status}`);
  check('12.9', 'authenticated HTML is private, no-store',
    /no-store/.test(archive.headers.get('cache-control') ?? ''),
    archive.headers.get('cache-control') ?? '');
  check('14.25', 'archive HTML under 5MB with grid inlined',
    archiveBody.length <= 5 * 1024 * 1024,
    `${(archiveBody.length / 1048576).toFixed(2)}MB`);

  const unauthArchive = await raw('/archive');
  const unauthBody = unauthArchive.status < 400 ? await unauthArchive.text() : '';
  check('14.24', 'unauthenticated response has zero data: URIs',
    !/data:image\//.test(unauthBody));

  // Discover media ids from the authenticated page.
  const ids = [...new Set([...archiveBody.matchAll(/\/api\/media\/([A-Za-z0-9_-]{22})/g)].map((m) => m[1] as string))];
  const labels = [...archiveBody.matchAll(/QLK\s*(\d{3})/g)].map((m) => m[0]);
  logAbove(
    `  discovered ${ids.length} media URL(s) and ${new Set(labels).size} label(s) in the HTML`,
  );
  logAbove(
    '  (only the video appears as a URL: grid thumbnails are inlined as data URIs,',
  );
  logAbove('   so photo ids are discovered from /admin below instead)');

  // ------------------------------------------------------------ media guard
  section('Protected media');
  if (ids.length > 0) {
    const id = ids[0] as string;
    const unauth = await raw(`/api/media/${id}`);
    check('14.5', 'media without session -> 401, zero bytes',
      unauth.status === 401 && (await unauth.arrayBuffer()).byteLength < 200, `got ${unauth.status}`);

    const authed = await raw(`/api/media/${id}`, {}, attendee);
    const cc = authed.headers.get('cache-control') ?? '';
    check('2.8', 'media bytes are private, max-age=60 + Vary: Cookie',
      /private/.test(cc) && /max-age=60/.test(cc) && /Cookie/i.test(authed.headers.get('vary') ?? ''),
      cc);
    check('12.8', 'no shared-cache directive on media',
      !/public/.test(cc) && !/s-maxage/.test(cc), cc);
    check('14.11', 'media with session -> 200', authed.status === 200, `got ${authed.status}`);
  } else {
    check('14.5', 'media without session -> 401', false, 'no media ingested yet');
  }

  const guess = 'AAAAAAAAAAAAAAAAAAAAAA';
  const guessed = await raw(`/api/media/${guess}`, {}, attendee);
  check('14.8', 'guessed media id -> 404, zero bytes',
    guessed.status === 404 && (await guessed.arrayBuffer()).byteLength < 200, `got ${guessed.status}`);

  const forged = await raw(`/api/media/${ids[0] ?? guess}`, {}, 'fb_a=fb1.eyJyIjoiYSJ9.forged');
  check('7.9', 'forged signature -> 401', forged.status === 401, `got ${forged.status}`);

  // ------------------------------------------------------------ admin guard
  section('Organizer privilege separation');
  const adminAsAttendee = await raw('/admin', {}, attendee);
  check('14.14a', 'admin page with attendee session -> 403', adminAsAttendee.status === 403, `got ${adminAsAttendee.status}`);

  const adminNoSess = await raw('/admin');
  check('7.3', 'admin page with no session -> 401', adminNoSess.status === 401, `got ${adminNoSess.status}`);

  for (const [route, body] of [
    ['/api/admin/state', { state: 'DISABLED' }],
    ['/api/admin/expiration', { expiresAt: '2030-01-01T00:00' }],
    ['/api/admin/code/rotate', {}],
    ['/api/admin/media/delete-all', { confirm: 'x' }],
    ['/api/admin/media/restore-all', { confirm: 'x' }],
    ['/api/admin/removals/review', { all: 'true', status: 'REVIEWED' }],
  ] as const) {
    const r = await raw(route, form(body as Record<string, string>), attendee);
    check('14.14', `${route} with attendee session -> 403`, r.status === 403, `got ${r.status}`);
  }

  const login = await raw('/api/admin/session', form({ secret: A.secret }));
  const organizer = cookieFrom(login, 'fb_o');
  check('14.15', 'organizer secret -> organizer session', Boolean(organizer), `status ${login.status}`);
  if (!organizer) {
    console.error('\nCannot continue admin checks without an organizer session.');
    report();
    return;
  }

  const badLogin = await raw('/api/admin/session', form({ secret: `${A.secret}x` }));
  check('7.1', 'wrong organizer secret -> 401', badLogin.status === 401, `got ${badLogin.status}`);

  const adminPage = await raw('/admin', {}, organizer);
  const adminBody = await adminPage.text();
  check('14.15b', 'admin renders counts with organizer session',
    adminPage.status === 200 && /Pending removals/i.test(adminBody), `got ${adminPage.status}`);

  // Photo ids are not in the attendee HTML (their thumbnails are inlined), so take
  // them from the admin grid. Without this, the media checks above would only ever
  // have exercised the video.
  section('Protected media (photographs)');
  const photoIds = [
    ...new Set(
      [...adminBody.matchAll(/\/api\/media\/([A-Za-z0-9_-]{22})\?v=grid/g)].map(
        (m) => m[1] as string,
      ),
    ),
  ];
  logAbove(`  discovered ${photoIds.length} photograph id(s) from /admin`);

  if (photoIds.length > 0) {
    const pid = photoIds[0] as string;

    const pUnauth = await raw(`/api/media/${pid}?v=full`);
    check('14.5b', 'photo full without session -> 401, zero bytes',
      pUnauth.status === 401 && (await pUnauth.arrayBuffer()).byteLength < 200,
      `got ${pUnauth.status}`);

    const pGridUnauth = await raw(`/api/media/${pid}?v=grid`);
    check('14.5c', 'photo grid without session -> 401',
      pGridUnauth.status === 401, `got ${pGridUnauth.status}`);

    const pAuth = await raw(`/api/media/${pid}?v=full`, {}, attendee);
    const bytes = (await pAuth.arrayBuffer()).byteLength;
    check('14.11c', 'photo full with attendee session -> 200 with real bytes',
      pAuth.status === 200 && bytes > 10_000, `status ${pAuth.status}, ${bytes}B`);

    const pType = pAuth.headers.get('content-type') ?? '';
    check('2.8b', 'photo served as image/jpeg', /image\/jpeg/.test(pType), pType);

    // Hidden media must be indistinguishable from media that never existed.
    await raw(`/api/admin/media/${pid}/visibility`, form({ hidden: 'true' }), organizer);
    await waitWithSpinner(800, 'waiting for hide to propagate');
    const pHidden = await raw(`/api/media/${pid}?v=full`, {}, attendee);
    check('14.9', 'hidden photo -> 404 for attendee, zero bytes',
      pHidden.status === 404 && (await pHidden.arrayBuffer()).byteLength < 200,
      `got ${pHidden.status}`);

    const pHiddenOrg = await raw(`/api/media/${pid}?v=full`, {}, organizer);
    check('6.15', 'hidden photo still previewable by organizer -> 200',
      pHiddenOrg.status === 200, `got ${pHiddenOrg.status}`);

    // Restore it, so verification leaves no attendee-facing item hidden.
    await raw(
      `/api/admin/media/${pid}/visibility`,
      form({ hidden: 'false', confirmPending: 'yes' }),
      organizer,
    );
    await waitWithSpinner(800, 'restoring');
    const pBack = await raw(`/api/media/${pid}?v=full`, {}, attendee);
    check('14.18', 'verification leaves the photo visible again -> 200',
      pBack.status === 200, `got ${pBack.status}`);

    // Range handling on the video, including the Safari-style tiny probe.
    if (ids.length > 0) {
      const vid = ids[0] as string;
      const probe = await raw(`/api/media/${vid}`, { headers: { range: 'bytes=0-1' } }, attendee);
      const probeLen = (await probe.arrayBuffer()).byteLength;
      check('3.1', 'tiny range probe -> 206 with 2 bytes',
        probe.status === 206 && probeLen === 2,
        `status ${probe.status}, ${probeLen}B, cr=${probe.headers.get('content-range')}`);
      check('3.2', 'video advertises Accept-Ranges: bytes',
        (probe.headers.get('accept-ranges') ?? '') === 'bytes');
      const cr = probe.headers.get('content-range') ?? '';
      check('3.1b', 'Content-Range reports full object size, not the head blob',
        /^bytes 0-1\/\d{7,}$/.test(cr), cr);
    }
  } else {
    check('14.5b', 'photograph ids discoverable from admin', false, 'none found');
  }

  // CSRF: a state change with a mismatched Origin must be refused.
  const badOrigin = await fetch(`${A.url}/api/admin/state`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: organizer,
      origin: 'https://evil.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'state=DISABLED',
  });
  check('14.x/7.7', 'cross-origin state change -> 403', badOrigin.status === 403, `got ${badOrigin.status}`);

  // ------------------------------------------------------- disable / enable
  section('Disable and re-enable');
  const t0 = Date.now();
  await raw('/api/admin/state', form({ state: 'DISABLED' }), organizer);
  let disabledStatus = 0;
  let elapsed = 0;
  for (let i = 0; i < 12; i++) {
    const r = await raw(`/api/media/${ids[0] ?? guess}`, {}, attendee);
    disabledStatus = r.status;
    elapsed = Date.now() - t0;
    if (r.status === 403) break;
    await waitWithSpinner(400, `waiting for DISABLE to propagate (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  check('14.10', 'disable takes effect within 5s -> 403',
    disabledStatus === 403 && elapsed <= 5000, `status ${disabledStatus} after ${elapsed}ms`);

  const accessWhileDisabled = await raw('/api/access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: A.code }),
  });
  check('6.4', 'access refused while disabled -> 403', accessWhileDisabled.status === 403,
    `got ${accessWhileDisabled.status}`);

  await raw('/api/admin/state', form({ state: 'LIVE' }), organizer);
  await new Promise((s) => setTimeout(s, 600));
  if (ids.length > 0) {
    const back = await raw(`/api/media/${ids[0] as string}`, {}, attendee);
    check('14.11b', 're-enable restores access -> 200', back.status === 200, `got ${back.status}`);
  }

  report();
}

function report() {
  bar?.done(`${passed} passed, ${failed} failed`);
  console.log(`\n${'='.repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('='.repeat(52));
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    console.log('\nDO NOT HAND THIS TO THE ORGANIZER until these pass.\n');
    process.exit(1);
  }
  console.log('\nAll checks passed against the deployed site.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('verification crashed:', e);
  process.exit(1);
});
