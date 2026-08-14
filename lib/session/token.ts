// Session tokens: fb1.<payload-b64url>.<sig-b64url>
//
// This module must run in BOTH the Node runtime (route handlers) and the Deno
// edge runtime (middleware). It therefore imports nothing at all — Web Crypto
// and standard globals only. No `node:crypto`, no Blobs.

export type Role = 'attendee' | 'organizer';

export interface SessionPayload {
  r: 'a' | 'o';
  cv: number; // code version at issue time; attendee only, 0 for organizer
  iat: number;
  exp: number;
  jti: string;
}

const PREFIX = 'fb1';
const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/**
 * Constant-time comparison. Portable so the same code runs under Deno edge,
 * where `node:crypto.timingSafeEqual` is unavailable. Length is not secret here.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(secret: string, data: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export function randomId(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64urlEncode(b);
}

export async function mintToken(
  secret: string,
  role: Role,
  codeVersion: number,
  ttlSeconds: number,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    r: role === 'organizer' ? 'o' : 'a',
    cv: role === 'organizer' ? 0 : codeVersion,
    iat,
    exp: iat + ttlSeconds,
    jti: randomId(12),
  };
  const p = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const body = `${PREFIX}.${p}`;
  const sig = await sign(secret, body);
  return `${body}.${b64urlEncode(sig)}`;
}

/**
 * Verify a token. EVERY failure mode collapses to `null`, i.e. "this request
 * carries no session". There is no distinct outcome for a tampered signature
 * versus an absent cookie, so probing tells an attacker nothing.
 */
export async function verifyToken(
  secret: string,
  token: string | undefined,
  expectRole: Role,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [prefix, p, s] = parts as [string, string, string];
  if (prefix !== PREFIX) return null;

  let expected: Uint8Array;
  try {
    expected = await sign(secret, `${PREFIX}.${p}`);
  } catch {
    return null;
  }

  let actual: Uint8Array;
  try {
    actual = b64urlDecode(s);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, actual)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null;
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;

  const role: Role = payload.r === 'o' ? 'organizer' : 'attendee';
  if (role !== expectRole) return null;

  return payload;
}
