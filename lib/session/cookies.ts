import { SESSION_TTL_SECONDS } from '../config/env';

export const ATTENDEE_COOKIE = 'fb_a';
export const ORGANIZER_COOKIE = 'fb_o';

/**
 * Two separate cookie names AND a role field inside the signed payload. Either
 * alone would do; both together mean an attendee token pasted into the organizer
 * slot fails the role check, and a forged organizer cookie fails the signature.
 */
export function serializeSessionCookie(name: string, value: string): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; ');
}

export function clearSessionCookie(name: string): string {
  return [`${name}=`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=0'].join('; ');
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
