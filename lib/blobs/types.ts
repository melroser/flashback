// Document shapes stored in Netlify Blobs. There is no conventional database.
//
// Two stores exist:
//   flashback-meta  — strong consistency. All safety-relevant state.
//   flashback-media — default consistency. Immutable bytes only.

export type ArchiveState = 'LIVE' | 'DISABLED';
export type MediaType = 'photo' | 'video';

/**
 * Media variants.
 *
 * - `full`   photo, longest edge <= 2400px, <= 1MB. Served via Media_API on lightbox open.
 * - `grid`   photo, longest edge ~400px. Base64-INLINED into the gated /archive HTML,
 *            never fetched separately. Collapses ~41 function invocations per grid
 *            view down to 1, which matters because Netlify Free is credit-metered.
 * - `poster` video poster frame. Served via Media_API.
 * - `head`   first 256KB of a video. Because ffmpeg writes with `+faststart` the moov
 *            atom sits at the front, so Safari/iOS tiny probe ranges (`bytes=0-1`)
 *            resolve from this small object instead of pulling the whole 18MB blob.
 */
export type Variant = 'full' | 'grid' | 'poster' | 'head';

export interface VariantMeta {
  width: number;
  height: number;
  byteLength: number;
  contentType: string;
}

export interface MediaEntry {
  mediaId: string; // opaque, 22-char base64url of 16 random bytes
  type: MediaType;
  label: string; // 'QLK 007'
  order: number;
  variants: Partial<Record<Variant, VariantMeta>>;
  durationMs?: number;
  hasAudio?: boolean;
  ingestedAt: string;
  /**
   * Reserved seam for the future subject-consent system. v1 never reads or
   * writes this. It exists so adding per-subject consent later is one extra
   * predicate in the gate rather than a data migration.
   */
  subjects?: unknown[];
}

export interface MediaIndex {
  schema: 1;
  archiveId: string;
  entries: MediaEntry[];
  builtAt: string;
}

export interface ArchiveConfig {
  schema: 1;
  archiveId: string;
  eventName: string;
  state: ArchiveState;
  expiresAt: string; // ISO 8601 UTC
  codeVersion: number; // bumped on every rotation; invalidates prior sessions
  featuredMediaId: string | null;
  /** Set when no attendee code exists. Archive is forced DISABLED: no code must never mean no lock. */
  seedFailure?: string;
  createdAt: string;
  updatedAt: string;
}

/** One tiny document per Media_Item. Blobs has no compare-and-swap, so a shared
 *  mutable index would lose writes — and a lost write here is a lost *hide*. */
export interface Visibility {
  schema: 1;
  mediaId: string;
  hidden: boolean;
  deleted: boolean;
  rev: number;
  updatedAt: string;
  reason: 'INGEST' | 'ORGANIZER' | 'REMOVAL_REQUEST';
}

/** Derived, display-only, self-healing. The gate NEVER reads this. */
export interface VisSummary {
  schema: 1;
  hiddenIds: string[];
  deletedIds: string[];
  builtAt: string;
}

export interface AttendeeCodeRecord {
  schema: 1;
  algo: 'pbkdf2-sha256';
  iterations: number; // 600_000 per current OWASP guidance
  salt: string;
  hash: string;
  codeLength: number;
  codeVersion: number;
  rotatedAt: string;
}

export interface RemovalRecord {
  schema: 1;
  recordId: string;
  mediaId: string;
  submittedAt: string;
  note?: string;
  status: 'PENDING' | 'REVIEWED' | 'DISMISSED';
  reviewedAt?: string;
}

export interface RateWindow {
  schema: 1;
  hits: number[];
}
