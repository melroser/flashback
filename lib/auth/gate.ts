// THE SINGLE AUTHORIZATION GATE.
//
// One function decides everything. The only code path that can obtain media bytes
// requires a GateProof, and a GateProof can only be constructed inside this
// module. Bypassing authorization is therefore a type error, not a code review
// finding. Backed by an ESLint import zone that forbids importing the media store
// from anywhere except lib/media/serve.ts.

import { sessionKey } from '../config/env';
import { readCookie, ATTENDEE_COOKIE, ORGANIZER_COOKIE } from '../session/cookies';
import { verifyToken } from '../session/token';
import { ensureSeeded } from '../blobs/seed';
import { readIndex, readVisibility } from '../blobs/meta';
import type { ArchiveConfig, MediaEntry, Variant, Visibility } from '../blobs/types';

export type Role = 'attendee' | 'organizer';

export type DenialCode =
  | 'NO_SESSION'
  | 'ARCHIVE_DISABLED'
  | 'ARCHIVE_EXPIRED'
  | 'ROLE_INSUFFICIENT'
  | 'MEDIA_UNKNOWN'
  | 'MEDIA_HIDDEN'
  | 'MEDIA_DELETED'
  | 'STATE_UNREADABLE';

export interface GateDenial {
  ok: false;
  status: 401 | 403 | 404 | 503;
  code: DenialCode;
}

declare const proofBrand: unique symbol;

/** Constructible only inside this module. Holding one is proof the chain ran. */
export interface GateProof {
  readonly [proofBrand]: true;
  readonly role: Role;
  readonly mediaId: string;
  readonly variant: Variant;
  readonly entry: MediaEntry;
}

export type GateMediaResult = { ok: true; proof: GateProof } | GateDenial;
export type GateViewResult =
  | { ok: true; role: Role; config: ArchiveConfig }
  | GateDenial;

const deny = (status: GateDenial['status'], code: DenialCode): GateDenial => ({
  ok: false,
  status,
  code,
});

/** Resolve a session from cookies. Every failure mode returns null. */
async function resolveRole(req: Request): Promise<{ role: Role; codeVersion: number } | null> {
  const cookies = req.headers.get('cookie');
  const key = sessionKey();

  const org = await verifyToken(key, readCookie(cookies, ORGANIZER_COOKIE), 'organizer');
  if (org) return { role: 'organizer', codeVersion: 0 };

  const att = await verifyToken(key, readCookie(cookies, ATTENDEE_COOKIE), 'attendee');
  if (att) return { role: 'attendee', codeVersion: att.cv };

  return null;
}

function archiveOpenFor(role: Role, config: ArchiveConfig): GateDenial | null {
  // Organizers keep access to a disabled or expired archive; that is how review
  // and recovery work at all. The ORDER of checks is fixed regardless of role.
  if (role === 'organizer') return null;
  if (config.state !== 'LIVE') return deny(403, 'ARCHIVE_DISABLED');
  if (Date.now() >= Date.parse(config.expiresAt)) return deny(403, 'ARCHIVE_EXPIRED');
  return null;
}

/**
 * View gate: session -> archive state -> expiration.
 * Used by /archive and by the Removal_API.
 */
export async function gateView(req: Request): Promise<GateViewResult> {
  try {
    const session = await resolveRole(req);
    if (!session) return deny(401, 'NO_SESSION');

    const config = await ensureSeeded();
    if (session.role === 'attendee' && session.codeVersion !== config.codeVersion) {
      // Code was rotated after this token was issued.
      return deny(401, 'NO_SESSION');
    }

    const closed = archiveOpenFor(session.role, config);
    if (closed) return closed;

    return { ok: true, role: session.role, config };
  } catch {
    // Fail closed. There is no path where a read failure results in access.
    return deny(503, 'STATE_UNREADABLE');
  }
}

/**
 * Media gate. Ordered chain, returning at the first failure:
 *   1. session
 *   2. archive state
 *   3. expiration
 *   4. existence
 *   5. visibility
 *
 * Cost: three strongly-consistent reads on a cold instance (config, index,
 * vis/{mediaId}); two when warm, because the immutable index is cached in module
 * scope. config and vis are NEVER cached.
 *
 * MEDIA_UNKNOWN, MEDIA_HIDDEN and MEDIA_DELETED all surface as 404 and are
 * indistinguishable from each other, so probing reveals nothing.
 */
export async function gateMedia(
  req: Request,
  mediaId: string,
  variant: Variant,
): Promise<GateMediaResult> {
  try {
    const view = await gateView(req);
    if (!view.ok) return view;

    const index = await readIndex();
    if (!index) return deny(404, 'MEDIA_UNKNOWN');

    const entry = index.entries.find((e) => e.mediaId === mediaId);
    if (!entry) return deny(404, 'MEDIA_UNKNOWN');
    if (!entry.variants[variant]) return deny(404, 'MEDIA_UNKNOWN');

    const vis: Visibility | null = await readVisibility(mediaId);
    if (vis?.deleted) return deny(404, 'MEDIA_DELETED');
    // The Organizer must be able to preview hidden items in order to review them.
    if (vis?.hidden && view.role !== 'organizer') return deny(404, 'MEDIA_HIDDEN');

    const proof = {
      role: view.role,
      mediaId: entry.mediaId,
      variant,
      entry,
    } as unknown as GateProof;

    return { ok: true, proof };
  } catch {
    return deny(503, 'STATE_UNREADABLE');
  }
}

const DENIAL_BODY: Record<GateDenial['status'], string> = {
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  503: 'UNAVAILABLE',
};

/** No stack traces, no blob keys, no hint about expected values. */
export function denialResponse(d: GateDenial): Response {
  return new Response(JSON.stringify({ error: DENIAL_BODY[d.status] }), {
    status: d.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Batched grid gate.
 *
 * The Archive_View inlines every grid thumbnail as a base64 data URI in one gated
 * HTML response, so it needs proofs for many items after a single authorization
 * pass rather than one gate call per tile. This runs exactly the same chain —
 * session, state, expiry, existence, visibility — just batched, and proof
 * construction stays inside this module.
 */
export async function gateGrid(req: Request): Promise<
  | {
      ok: true;
      role: Role;
      config: ArchiveConfig;
      photos: GateProof[];
      featured: GateProof | null;
      featuredEntry: MediaEntry | null;
    }
  | GateDenial
> {
  try {
    const view = await gateView(req);
    if (!view.ok) return view;

    const index = await readIndex();
    if (!index) {
      return { ok: true, role: view.role, config: view.config, photos: [], featured: null, featuredEntry: null };
    }

    const visible: MediaEntry[] = [];
    for (const entry of [...index.entries].sort((a, b) => a.order - b.order)) {
      const vis = await readVisibility(entry.mediaId);
      if (vis?.deleted) continue;
      if (vis?.hidden && view.role !== 'organizer') continue;
      visible.push(entry);
    }

    const mk = (entry: MediaEntry, variant: Variant): GateProof =>
      ({ role: view.role, mediaId: entry.mediaId, variant, entry } as unknown as GateProof);

    const photos = visible
      .filter((e) => e.type === 'photo' && e.variants.grid)
      .map((e) => mk(e, 'grid'));

    const featuredEntry =
      visible.find(
        (e) => e.type === 'video' && e.mediaId === view.config.featuredMediaId,
      ) ?? visible.find((e) => e.type === 'video') ?? null;

    return {
      ok: true,
      role: view.role,
      config: view.config,
      photos,
      featured: featuredEntry ? mk(featuredEntry, 'full') : null,
      featuredEntry,
    };
  } catch {
    return deny(503, 'STATE_UNREADABLE');
  }
}
