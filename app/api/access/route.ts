import { NextResponse } from 'next/server';
import { sessionKey, SESSION_TTL_SECONDS } from '@/lib/config/env';
import { ensureSeeded, readCodeRecord } from '@/lib/blobs/seed';
import { verifyCode } from '@/lib/access/code';
import { mintToken } from '@/lib/session/token';
import { ATTENDEE_COOKIE, serializeSessionCookie } from '@/lib/session/cookies';
import { checkRate, recordHit, tooManyRequests } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const FAIL = () =>
  new Response(JSON.stringify({ error: 'INVALID' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

const CLOSED = () =>
  new Response(JSON.stringify({ error: 'FORBIDDEN' }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

export async function POST(req: Request) {
  // 1. Rate limit.
  const rate = await checkRate(req, 'access');
  if (rate.limited) return tooManyRequests();

  // 2. Read submitted value from either JSON or a form post.
  let submitted = '';
  const ct = req.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      const body = (await req.json()) as { code?: unknown };
      submitted = typeof body.code === 'string' ? body.code : '';
    } else {
      const form = await req.formData();
      const v = form.get('code');
      submitted = typeof v === 'string' ? v : '';
    }
  } catch {
    return FAIL();
  }

  const config = await ensureSeeded();

  // 3 & 4. State and expiry are checked BEFORE the hash comparison, so a disabled
  // or expired archive returns 403 even for the correct code, and does so cheaply.
  if (config.state !== 'LIVE') return CLOSED();
  if (Date.now() >= Date.parse(config.expiresAt)) return CLOSED();

  const record = await readCodeRecord();
  if (!record) return CLOSED();

  const ok = submitted.length > 0 && (await verifyCode(submitted, record));
  if (!ok) {
    await recordHit('access', rate.hash);
    return FAIL();
  }

  const token = await mintToken(sessionKey(), 'attendee', config.codeVersion, SESSION_TTL_SECONDS);

  const res = NextResponse.redirect(new URL('/archive', req.url), 303);
  res.headers.append('set-cookie', serializeSessionCookie(ATTENDEE_COOKIE, token));
  res.headers.set('cache-control', 'private, no-store');
  return res;
}
