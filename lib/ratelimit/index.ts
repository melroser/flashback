import { archiveId, sessionKey } from '../config/env';
import { rateKey } from '../blobs/keys';
import { metaStore } from '../blobs/meta';
import { b64urlEncode } from '../session/token';
import type { RateWindow } from '../blobs/types';

export type RateScope = 'access' | 'removal' | 'admin-login';

export const RATE_LIMITS: Record<RateScope, number> = {
  access: 10,
  removal: 20,
  'admin-login': 5,
};

const WINDOW_MS = 60_000;

/**
 * Client IP. `x-nf-client-connection-ip` is set by Netlify's edge and is the one
 * to trust; `x-forwarded-for` is client-spoofable and exists here only so local
 * development works.
 */
export function clientIp(req: Request): string {
  return (
    req.headers.get('x-nf-client-connection-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

/**
 * The raw IP is NEVER stored. The key is an HMAC salted with the UTC date, so it
 * is not a stable identifier across days and cannot be used to correlate a
 * visitor over time.
 */
async function ipHash(ip: string, scope: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sessionKey()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${ip}|${scope}|${day}`),
  );
  return b64urlEncode(new Uint8Array(sig)).slice(0, 22);
}

/**
 * Sliding window in one small blob document per (scope, client).
 *
 * This is a best-effort deterrent and the limitations are real:
 *   - Lost updates. Blobs has no compare-and-swap, so concurrent requests from
 *     one IP can both read the same array and both write; one append is lost.
 *     Under burst load this undercounts.
 *   - The check-then-write sequence is not atomic across regions.
 *   - Per-IP only. Anyone with a handful of addresses walks around it.
 *   - No TTL in Blobs, so keys are pruned lazily on read.
 *
 * The real defenses against code brute force are the PBKDF2 cost per attempt, the
 * 12-day archive lifetime, and an Organizer who can kill access in one click. This
 * raises the floor; it is not the wall.
 */
export async function checkRate(
  req: Request,
  scope: RateScope,
): Promise<{ limited: boolean; hash: string }> {
  const limit = RATE_LIMITS[scope];
  const hash = await ipHash(clientIp(req), scope);
  const key = rateKey(archiveId(), scope, hash);
  try {
    const doc = (await metaStore().get(key, { type: 'json' })) as RateWindow | null;
    const now = Date.now();
    const hits = (doc?.hits ?? []).filter((t) => now - t < WINDOW_MS);
    return { limited: hits.length >= limit, hash };
  } catch {
    // A limiter read failure must not lock people out of their own archive.
    return { limited: false, hash };
  }
}

/** Record a countable event. */
export async function recordHit(scope: RateScope, hash: string): Promise<void> {
  const limit = RATE_LIMITS[scope];
  const key = rateKey(archiveId(), scope, hash);
  try {
    const doc = (await metaStore().get(key, { type: 'json' })) as RateWindow | null;
    const now = Date.now();
    const hits = (doc?.hits ?? []).filter((t) => now - t < WINDOW_MS);
    hits.push(now);
    await metaStore().setJSON(key, {
      schema: 1,
      hits: hits.slice(-(limit + 1)),
    } satisfies RateWindow);
  } catch {
    // Non-fatal.
  }
}

export function tooManyRequests(): Response {
  return new Response(JSON.stringify({ error: 'SLOW_DOWN' }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': '60',
      'cache-control': 'private, no-store',
    },
  });
}
