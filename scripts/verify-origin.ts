/**
 * FLASHBACK Origin-check verification.
 *
 *   npm run verify:origin -- --url https://site.netlify.app --secret xxx
 *
 * Falls back to BASE_URL and FB_SECRET when the flags are omitted.
 *
 * WHY THIS EXISTS
 *
 * `withOrganizer` compares the request `Origin` against the site origin as defence
 * in depth behind SameSite=Strict. Twice now that comparison has refused a
 * legitimate same-origin form submission: first in Safari, which omits `Origin`
 * entirely, then in Chrome, which sends the literal `Origin: null` on a same-origin
 * form navigation because we serve `Referrer-Policy: no-referrer` per Requirement
 * 12.3. Both times every button on /admin returned FORBIDDEN, and both times the
 * fetch-based Contract_Suite passed, because a fetch client sends an `Origin` that a
 * browser form does not.
 *
 * A browser was needed to DISCOVER that. A browser is not needed to TEST it: any
 * HTTP client can set the header to whatever it likes. This probe does exactly
 * that, so the fix is gated by evidence rather than by an engine install.
 *
 * SAFETY
 *
 * The probe is `POST /api/admin/media/delete-all` carrying a `confirm` value that
 * cannot match the string the route requires. That route builds its expected
 * confirmation as `DELETE ALL <n> ITEMS` and returns 400 CONFIRM_REQUIRED before it
 * touches visibility or bytes, so a mismatched confirmation deletes nothing. It is
 * chosen precisely because it runs the whole `withOrganizer` chain — session,
 * privilege, Origin — and then refuses.
 *
 * A 400 is therefore the proof we want: it can only be produced by the handler
 * body, which only runs once the Origin check has passed. A 403 means the Origin
 * check refused the request.
 *
 * This run performs zero writes to the archive.
 */

import { Progress, logAbove } from './lib/progress';

interface Args {
  url: string;
  secret: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i === -1 ? undefined : a[i + 1];
  };
  const url = get('url') ?? process.env.BASE_URL;
  const secret = get('secret') ?? process.env.FB_SECRET;
  if (!url || !secret) {
    console.error('usage: npm run verify:origin -- --url <url> --secret <secret>');
    console.error('  --url     site origin to probe   (or env BASE_URL)');
    console.error('  --secret  organizer secret       (or env FB_SECRET)');
    process.exit(2);
  }
  if (!/^https?:\/\//.test(url)) {
    console.error(`--url must be an absolute http(s) origin, got: ${url}`);
    process.exit(2);
  }
  return { url: url.replace(/\/$/, ''), secret };
}

const A = parseArgs();

/**
 * Deliberately unmatchable. The route computes `DELETE ALL <n> ITEMS`, so any value
 * outside that shape is refused for every possible item count. Asserted below
 * rather than merely asserted in prose, so a future edit to this constant cannot
 * quietly turn the probe into a deletion.
 */
const SAFE_CONFIRM = 'ORIGIN-PROBE-DO-NOT-DELETE';
if (/^DELETE ALL \d+ ITEMS$/.test(SAFE_CONFIRM)) {
  console.error('refusing to run: the probe confirmation could match a real deletion');
  process.exit(2);
}

const PROBE_PATH = '/api/admin/media/delete-all';

// Kept in step with the checks below so the bar is honest.
const TOTAL_CHECKS = 6;
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

function cookieFrom(res: Response, name: string): string | undefined {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    if (raw.startsWith(`${name}=`)) {
      const v = raw.split(';')[0];
      if (v && !v.endsWith('=')) return v;
    }
  }
  return undefined;
}

async function signIn(): Promise<string> {
  // No `Accept: text/html`, so a wrong secret answers 401 JSON instead of bouncing
  // to the sign-in form, which makes the failure below legible.
  const res = await fetch(`${A.url}/api/admin/session`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: A.url,
    },
    body: new URLSearchParams({ secret: A.secret }).toString(),
  });

  const cookie = cookieFrom(res, 'fb_o');
  if (!cookie) {
    console.error(`\nOrganizer sign-in failed: ${A.url} answered ${res.status} with no fb_o cookie.`);
    if (res.status === 401) console.error('  The organizer secret was rejected. Check --secret / FB_SECRET.');
    else if (res.status === 429) console.error('  Rate limited. Wait a minute and retry.');
    else if (res.status === 500) console.error('  The site errored. FLASHBACK_ORGANIZER_SECRET may be unset there.');
    else console.error(`  Unexpected status. Body: ${(await res.text()).slice(0, 200)}`);
    console.error('\nEvery Origin check below needs an organizer session. Nothing was verified.\n');
    process.exit(1);
  }
  return cookie;
}

interface ProbeResult {
  status: number;
  error: string;
  message: string;
}

/** One state-changing admin POST. `origin === null` omits the header entirely. */
async function probe(cookie: string, origin: string | null): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    cookie,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (origin !== null) headers.origin = origin;

  const res = await fetch(`${A.url}${PROBE_PATH}`, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: new URLSearchParams({ confirm: SAFE_CONFIRM }).toString(),
  });

  const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
  return {
    status: res.status,
    error: typeof body.error === 'string' ? body.error : '',
    message: typeof body.message === 'string' ? body.message : '',
  };
}

/** The handler body ran and refused the confirmation, so the Origin check passed. */
function reached(r: ProbeResult): boolean {
  return r.status === 400 && r.error === 'CONFIRM_REQUIRED';
}

function describe(r: ProbeResult): string {
  return `got ${r.status}${r.error ? ` ${r.error}` : ''}`;
}

async function main() {
  console.log(`\nFLASHBACK Origin verification against ${A.url}`);
  console.log(`  probe: POST ${PROBE_PATH} with a confirmation that cannot match`);
  console.log('  this run writes nothing and deletes nothing\n');

  const cookie = await signIn();
  logAbove('  organizer session established');

  bar = new Progress('checks', TOTAL_CHECKS);

  // A same-origin request must be accepted whichever of the three shapes the
  // browser chose to send. Requirement 1.4 and 5.16.
  section('Same-origin forms must proceed');

  const absent = await probe(cookie, null);
  check('1.4a', 'Origin absent (Safari form POST) -> reaches handler', reached(absent), describe(absent));
  if (absent.message) logAbove(`        route expects: ${absent.message}`);

  const opaque = await probe(cookie, 'null');
  check('1.4b', 'Origin: null (Chrome under no-referrer) -> reaches handler', reached(opaque), describe(opaque));

  const exact = await probe(cookie, A.url);
  check('1.4c', 'Origin exactly the site origin -> reaches handler', reached(exact), describe(exact));

  const slashed = await probe(cookie, `${A.url}/`);
  check('1.4d', 'Origin with a trailing slash -> reaches handler', reached(slashed), describe(slashed));

  // And a genuine cross-origin attempt must still be refused. Requirement 5.16.
  section('Cross-origin state change must be refused');

  const foreign = await probe(cookie, 'https://evil.example.com');
  check('7.7', 'foreign Origin -> 403 FORBIDDEN',
    foreign.status === 403 && foreign.error === 'FORBIDDEN', describe(foreign));

  // The probe is only meaningful if it never mutated anything, which is true only
  // while the route still refuses a mismatched confirmation.
  check('6.5', 'probe never deleted anything (confirmation refused throughout)',
    reached(absent) || reached(opaque) || reached(exact) || reached(slashed),
    'no probe reached the handler, so nothing proves the refusal path ran');

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
    console.log('\nA 403 on any same-origin form means the admin controls are dead in that');
    console.log('browser. If the exact-origin check is the only failure, FLASHBACK_SITE_ORIGIN');
    console.log(`on the deployed site probably does not equal ${A.url}.\n`);
    process.exit(1);
  }
  console.log('\nEvery Origin form behaves correctly against the deployed site.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('origin verification crashed:', e);
  process.exit(1);
});
