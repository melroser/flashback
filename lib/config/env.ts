// Environment access. The app refuses to start without a session signing key or
// an organizer secret: an unsigned session and an absent organizer secret are
// both failure modes that must not degrade quietly into an open archive.

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `FLASHBACK misconfigured: required environment variable ${name} is not set.`,
    );
  }
  return v;
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** HMAC key for session cookies and for rate-limit IP hashing. */
export const sessionKey = () => requireEnv('FLASHBACK_SESSION_KEY');

/** Organizer secret. Env-only, never persisted to Blobs, so an attendee-code
 *  holder can never escalate by reaching the blob store. */
export const organizerSecret = () => requireEnv('FLASHBACK_ORGANIZER_SECRET');

export const archiveId = () => optionalEnv('FLASHBACK_ARCHIVE_ID') ?? 'qlick-qrave';
/** Shown to organizers so they know who sent the link. */
export const photographer = () => optionalEnv('FLASHBACK_PHOTOGRAPHER') ?? 'The photographer';
export const eventName = () => optionalEnv('FLASHBACK_EVENT_NAME') ?? 'QLICK QRAVE';
export const attendeeCodeSeed = () => optionalEnv('FLASHBACK_ATTENDEE_CODE_SEED');
export const expiresAtSeed = () => optionalEnv('FLASHBACK_EXPIRES_AT');

/** Origin-check target for state-changing admin requests. Falls back to the
 *  URL Netlify injects at runtime. */
export const siteOrigin = () =>
  optionalEnv('FLASHBACK_SITE_ORIGIN') ?? optionalEnv('URL') ?? optionalEnv('DEPLOY_URL');

export const DEFAULT_EXPIRY_DAYS = 12;
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours
export const PBKDF2_ITERATIONS = 600_000; // current OWASP guidance for PBKDF2-HMAC-SHA256

/**
 * Explicit Blobs credentials.
 *
 * Inside the Netlify runtime these are injected automatically and this returns
 * nothing. Locally, `netlify dev` uses a SANDBOXED store that cannot see
 * production data, so supplying NETLIFY_SITE_ID and NETLIFY_API_TOKEN is what lets
 * a local server read the real archive.
 *
 * Pair that with a distinct FLASHBACK_ARCHIVE_ID locally to keep local writes in
 * their own key namespace, so local testing cannot hide or delete anything an
 * attendee can see.
 */
export function blobCreds(): { siteID?: string; token?: string } {
  const siteID = optionalEnv('NETLIFY_SITE_ID');
  const token = optionalEnv('NETLIFY_API_TOKEN');
  return siteID && token ? { siteID, token } : {};
}
