import { PBKDF2_ITERATIONS } from '../config/env';
import { b64urlEncode } from '../session/token';
import type { AttendeeCodeRecord } from '../blobs/types';

/**
 * 31 characters. Excludes 0, O, 1, I and L because this code gets transcribed off
 * a phone screen in a dark room.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const DEFAULT_CODE_LENGTH = 10;
export const MIN_CODE_LENGTH = 8;
export const MAX_CODE_LENGTH = 12;

/**
 * At length 10 this is 31^10 ~= 8.2e14, about 49.5 bits. That is NOT a password,
 * and nothing here pretends otherwise. It is defended by four things together:
 * the PBKDF2 cost per attempt, the sliding-window rate limiter, a 12-day archive
 * lifetime, and an Organizer who can kill access in one click.
 */
export function generateCode(length = DEFAULT_CODE_LENGTH): string {
  if (length < MIN_CODE_LENGTH || length > MAX_CODE_LENGTH) {
    throw new Error(`code length must be ${MIN_CODE_LENGTH}-${MAX_CODE_LENGTH}`);
  }
  const n = CODE_ALPHABET.length; // 31
  // Rejection sampling: reject bytes >= 248 before % 31 so the distribution is
  // uniform. Modulo bias on a 31-symbol alphabet is real and cheap to avoid.
  const limit = 256 - (256 % n); // 248
  let out = '';
  const buf = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    const b = buf[0] as number;
    if (b >= limit) continue;
    out += CODE_ALPHABET[b % n];
  }
  return out;
}

/** Strips leading, trailing and internal whitespace, then uppercases. */
export function normalizeCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

async function pbkdf2(
  code: string,
  saltBytes: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(code),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    // @ts-expect-error BufferSource variance across lib.dom/node typings
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function deriveCodeRecord(
  code: string,
  codeVersion: number,
): Promise<AttendeeCodeRecord> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(normalizeCode(code), salt, PBKDF2_ITERATIONS);
  return {
    schema: 1,
    algo: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: b64urlEncode(salt),
    hash: b64urlEncode(hash),
    codeLength: normalizeCode(code).length,
    codeVersion,
    rotatedAt: new Date().toISOString(),
  };
}

export async function verifyCode(
  submitted: string,
  record: AttendeeCodeRecord,
): Promise<boolean> {
  const { b64urlDecode, timingSafeEqual } = await import('../session/token');
  const salt = b64urlDecode(record.salt);
  const expected = b64urlDecode(record.hash);
  const actual = await pbkdf2(normalizeCode(submitted), salt, record.iterations);
  return timingSafeEqual(expected, actual);
}
