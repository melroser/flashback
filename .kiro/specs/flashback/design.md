# Design Document

## Overview

FLASHBACK is a single Next.js App Router application on Netlify. It has three human-facing surfaces (Access_Screen, Archive_View, Admin_View), four API surfaces (Access_API, Media_API, Removal_API, Admin_API), and one offline tool (Ingest_Script) that runs on the Photographer's laptop.

The whole design turns on one idea: **there is exactly one authorization gate, and the only code path that can obtain media bytes requires proof that the gate ran.** Every other decision in this document is downstream of that, or is a platform constraint we have to route around.

Three structural choices carry most of the safety weight:

1. **Two blob stores with different consistency settings.** All safety-relevant state (archive state, expiration, visibility flags, code hash) lives in a store created with `consistency: 'strong'`, so strong reads are a property of the store rather than something each call site has to remember. Media bytes live in a separate, default-consistency store. Requirement 2.11 becomes structurally true instead of a discipline problem.
2. **Mutable per-item visibility lives in its own tiny document per Media_Item.** Netlify Blobs has no compare-and-swap. Read-modify-write on a shared index document is last-writer-wins, and a lost write here means a lost *hide* — media staying visible after someone asked for it to come down. That is a safety failure, so we do not do it.
3. **A branded proof type gates byte access.** The media store handle is unreachable except from inside one function that requires a `GateProof` value, and `GateProof` can only be constructed by the gate. Bypassing authorization is a type error, not a code review finding.

Priorities, in the order they resolve conflicts: safety, shipping today, privacy, visual identity, simplicity, extensibility.

---

## Architecture

### Stack

| Concern | Choice | Version pin | Why |
| --- | --- | --- | --- |
| Framework | Next.js App Router | 15.x | Required by Requirement 13.1 |
| Language | TypeScript, `strict: true` | 5.x | Required |
| Styling | Tailwind CSS + `tailwind.config.ts` | 3.4.x | v3 config-file API is predictable; v4's CSS-first `@theme` is a same-day-ship risk for no benefit here |
| Netlify adapter | `@netlify/plugin-nextjs` | v5 | Auto-detected by Netlify build; runs the Next server as one Netlify Function and middleware as one Netlify Edge Function |
| Storage | `@netlify/blobs` | latest 8.x | Required |
| Image processing (ingest only) | `sharp` | pinned exact | Strips metadata by default; we verify rather than trust |
| Metadata verification (ingest only) | `exiftool-vendored` | pinned exact | Independent second opinion on stripping — see Ingest |
| Video processing (ingest only) | system `ffmpeg` via `ffmpeg-static` + `child_process.spawn` | pinned exact | No brew prerequisite for the Photographer; direct spawn avoids `fluent-ffmpeg` maintenance risk |
| Tests | Vitest + fast-check + @testing-library/react | latest | Property tests need a generator library |

No runtime dependency outside this list. Requirement 13.1, 13.2.

### Runtime placement

`@netlify/plugin-nextjs` v5 puts App Router pages and route handlers in a single Node-runtime Netlify Function, and Next middleware in a Deno-based Netlify Edge Function. That split dictates the following.

| Route | Rendering | Runtime | Notes |
| --- | --- | --- | --- |
| `/` Access_Screen | Server Component, `force-dynamic` | Node | Reads archive config (strong) to decide between the code form and the ended state |
| `/archive` Archive_View | Server Component, `force-dynamic` | Node | Gate runs server-side before any tile is emitted; carries the inline grid thumbnails, so this one invocation renders the whole grid |
| `/admin` Admin_View | Server Component, `force-dynamic` | Node | Status codes for the unauthorized cases come from middleware; the page re-verifies authoritatively |
| `POST /api/access` | Route Handler | Node | PBKDF2 verification needs real CPU and `node:` timing primitives |
| `GET/HEAD /api/media/[id]` | Route Handler | Node | Buffers up to 18 MB; needs Node memory headroom and stream support |
| `POST /api/removal` | Route Handler | Node | — |
| `POST /api/admin/*` | Route Handlers | Node | — |
| `app/robots.ts` | Static | — | Requirement 11.5 |
| `middleware.ts` | Edge Function (Deno) | Edge | Security headers, CSP nonce, coarse status/redirect only |

**No route uses `export const runtime = 'edge'`.** Netlify Blobs *is* reachable from edge functions, so that is not the reason. The reasons are: the Media_API needs to hold an 18 MB buffer and stream it, PBKDF2 at 600k iterations wants Node CPU, and running one runtime removes an entire category of "works locally, differs in prod" failure. Simplicity over cleverness on ship day.

Every dynamic route sets:

```ts
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
```

There is no ISR, no static generation, and no `unstable_cache` anywhere in the protected surface. A cached authorization decision is an authorization bypass.

### What middleware is and is not

Middleware does three things: attach the security header set, mint the per-request CSP nonce, and return the correct HTTP status for unauthenticated page requests (because a Server Component cannot set an arbitrary response status without Next 15's experimental `authInterrupts`, which we are not taking a dependency on).

Middleware is **not** the authorization boundary. It verifies only the cookie *signature*, which needs nothing but Web Crypto and the signing key. It never reads Blobs, never checks archive state, expiration, code version, or visibility. Requirement 11.6 and 2.2 are satisfied inside the route handler, every time, even for a request middleware waved through.

| Path | Middleware condition | Middleware response |
| --- | --- | --- |
| `/archive` | no valid-signature `fb_a` and no valid-signature `fb_o` | 307 redirect to `/` (Requirement 14.4 permits redirect) |
| `/admin` | valid `fb_o` signature | pass through |
| `/admin` | valid `fb_a` signature, no valid `fb_o` | **403** with the organizer login document (Requirement 7.2, 14.14) |
| `/admin` | neither | **401** with the organizer login document (Requirement 7.3) |
| all paths | — | header set + nonce |

The 401/403 body is a self-contained minimal HTML document containing the organizer secret form posting to `/api/admin/session`, styled by a nonce'd inline `<style>`. It is deliberately ugly and small — it is a status carrier, not a page.

To make the nonce reach the renderer, middleware sets the CSP header on both the outgoing response **and** the forwarded request:

```ts
const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
const csp = buildCsp(nonce);
const requestHeaders = new Headers(request.headers);
requestHeaders.set('content-security-policy', csp);
const res = NextResponse.next({ request: { headers: requestHeaders } });
res.headers.set('content-security-policy', csp);
```

Next.js reads the nonce out of the request's CSP header and stamps it onto its own bootstrap and Flight scripts. Skipping the request-header half is the usual way this silently breaks in production.

Because `verifyToken` must run in the Deno edge runtime, the session module imports **nothing** — Web Crypto and standard globals only. No `node:crypto`, no Blobs.

### Metered usage and the pause failure mode

The Netlify Free plan is credit-based: **300 credits per month, and exhausting them pauses every project owned by the team until the next billing cycle. Free has no auto-recharge** ([Netlify: resume paused projects](https://docs.netlify.com/manage/accounts-and-billing/billing/resume-paused-projects/)). This is not a soft throttle and it is not scoped to the offending site. It is a stop.

That matters here more than it would for most projects, because this architecture is close to worst-case for a metered plan. The central requirement — every byte passes the gate — means every byte is a function invocation. Nothing is a static asset, nothing is CDN-cacheable, nothing is free. In the first shape of this design:

- A 40-photo grid was **~41 invocations per view**: one for the page, forty for the thumbnails.
- `no-store` meant a revisit re-downloaded every one of them through functions again. Second view, another 41.
- Video seeking was worse. Each bounded range was an invocation, and because Netlify Blobs has no server-side range read, each of those invocations pulled the whole 18 MB object from the blob backend to return a 4 MB slice.

Two mitigations, designed in detail below, cut the invocation count rather than the safety guarantees:

| | Invocations per grid view | Invocations per revisit within 60 s |
| --- | --- | --- |
| Original shape | ~41 | ~41 |
| Inline grid thumbnails | 1 | 1 |
| Inline thumbnails + `private, max-age=60` on media | 1 | 1 for the HTML, 0 for media already fetched |

A third change, a 256 KB `head` object per video, does not reduce the invocation count but removes an 18 MB backend fetch from every iOS video load. All three are specified under Media Delivery and Range Streaming.

Counting a whole visit — page, poster, video start, a handful of seeks, ~8 lightbox opens — the estimate goes from roughly 57 invocations to roughly 16, and a revisit inside a minute costs close to one.

**What we do not know.** The credit conversion rate for function invocations and for bandwidth was not determined. Netlify publishes the 300-credit allowance but we did not establish how many invocations or how many GB one credit buys, so **how many gallery views 300 credits buys is unknown.** That number has to be read off the real account — after ingest, after a few real page loads, from the usage dashboard — before the archive is handed to the Organizer. Requirement 13.12 exists so the Organizer can read it too. Do not treat the invocation reductions above as proof of sufficiency; they are proof of direction.

**The failure mode.** If the allowance runs out, the site pauses at an unpredictable moment while the Archive_View countdown still shows days remaining. Media becoming unreachable is the *safe* direction to fail — a paused site serves nothing, which is exactly the posture the gate wants. But it breaks the promise made to the Organizer and to the attendees, and it does so silently and without warning. That asymmetry is why Requirements 13.11 and 13.12 put the pause behavior and the dashboard location in the README rather than leaving it as tribal knowledge between the Photographer and this document.

**On Netlify Blobs quotas.** The Free plan has historically included 100 GB of Blobs storage and 100 GB of bandwidth, which would be ample for ~40 photos and one video. We are not asserting that as a fact for this deployment: the credit model may supersede per-resource limits, and we did not verify how the two interact. The bandwidth estimate later in this document is therefore a sanity check on order of magnitude, not a headroom guarantee. Requirement 13.10's insistence on measuring against the deployed site rather than trusting published documentation applies here with full force.

---

## Data Models

Two stores, both site-wide via `getStore`. Zero deploy-scoped stores. Requirement 13.4.

```ts
// lib/blobs/meta.ts
export const metaStore = () => getStore({ name: 'flashback-meta', consistency: 'strong' });

// lib/blobs/media.ts  — NOT importable outside lib/media/serve.ts (enforced by lint rule)
const mediaStore = () => getStore({ name: 'flashback-media' });
```

`flashback-meta` is created with strong consistency, so every read of every safety value is a Strong_Read whether or not the caller asks. `flashback-media` uses the default eventual consistency because its contents are immutable once written and its visibility is decided entirely by `flashback-meta`.

That asymmetry needs one explicit note. Deleting a media blob is *eventually* consistent, so for up to ~60s a regional read could still return bytes for a deleted item. It cannot leak, because the gate reads the strongly-consistent visibility document first and returns 404 before the media store handle is ever obtained. Byte-level deletion is the second line of defense; the gate is the first.

### Key namespaces

`ARCHIVE_ID` defaults to `qlick-qrave` and comes from env. Every key is namespaced by it. v1 ships one archive; a second event is a new `ARCHIVE_ID`, not a migration.

| Store | Key | Document | Writers |
| --- | --- | --- | --- |
| meta | `arch/{archiveId}/config` | `ArchiveConfig` | Admin_API, first-boot seed |
| meta | `arch/{archiveId}/index` | `MediaIndex` | Ingest_Script only |
| meta | `arch/{archiveId}/vis/{mediaId}` | `Visibility` | Admin_API, Removal_API |
| meta | `arch/{archiveId}/vis-summary` | `VisSummary` | Admin_API, Removal_API (derived) |
| meta | `arch/{archiveId}/secret/attendee-code` | `AttendeeCodeRecord` | Admin_API rotate, first-boot seed, Ingest_Script |
| meta | `arch/{archiveId}/removals/{recordId}` | `RemovalRecord` | Removal_API, Admin_API review |
| meta | `arch/{archiveId}/rl/{scope}/{ipHash}` | `RateWindow` | Access_API, Removal_API, admin login |
| media | `arch/{archiveId}/media/{mediaId}/full` | raw bytes — photo derivative or video | Ingest_Script, deleted by Admin_API |
| media | `arch/{archiveId}/media/{mediaId}/grid` | raw bytes — Grid_Thumbnail, photo only | Ingest_Script, deleted by Admin_API |
| media | `arch/{archiveId}/media/{mediaId}/poster` | raw bytes — video poster frame | Ingest_Script, deleted by Admin_API |
| media | `arch/{archiveId}/media/{mediaId}/head` | raw bytes — first 256 KB of a video | Ingest_Script, deleted by Admin_API |

Longest key is well under the 600-byte limit. Documents are stored as the blob *value* (JSON), never as blob metadata, so the 2 KB metadata cap is irrelevant. Largest object is a video derivative at ≤18 MB, far under the 5 GB object cap. Store names are 14 bytes and contain neither `/` nor `:`, satisfying the naming rules.

`head` is the one key a client cannot ask for. It is not accepted as a `?v=` value; it is an internal storage detail read only by `serveMedia`, and only after the gate has already approved the video's `full` variant. See the Range handler.

**Keys are never built from raw user input.** Netlify's security guidance for Blobs is to scope keys with something callers cannot tamper with, and the gate does exactly that: the `[id]` path parameter is used only to *look up* an index entry, and the media key is constructed from `entry.mediaId` and a variant drawn from a fixed union. A caller cannot inject a key fragment, traverse a namespace, or reach the meta store through the Media_API, because the value they supply never reaches a key.

### Document shapes

```ts
type ArchiveState = 'LIVE' | 'DISABLED';
type MediaType = 'photo' | 'video';

// Request-addressable through /api/media/[id]?v=…
type Variant = 'full' | 'grid' | 'poster';
// Storage keys. 'head' is internal to serveMedia and never parsed from a request.
type StoredVariant = Variant | 'head';

interface ArchiveConfig {
  schema: 1;
  archiveId: string;          // 'qlick-qrave'
  eventName: string;          // 'QLICK QRAVE'
  state: ArchiveState;
  expiresAt: string;         // ISO 8601 UTC
  codeVersion: number;       // bumped on every rotation; see Sessions
  featuredMediaId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MediaEntry {
  mediaId: string;           // opaque, 22-char base64url of 16 random bytes
  type: MediaType;
  label: string;             // 'QLK 007'
  order: number;             // stable display order
  variants: {
    full:    { width: number; height: number; byteLength: number; contentType: string };
    grid?:   { width: number; height: number; byteLength: number; contentType: string };
    poster?: { width: number; height: number; byteLength: number; contentType: string };
    // Video only, internal. Prefix of `full`; absent when the video is <= 256 KB.
    head?:   { byteLength: number };
  };
  durationMs?: number;       // video only
  hasAudio?: boolean;        // video only
  ingestedAt: string;
  // Reserved seam for the future subject-consent system. v1 never reads or writes it.
  subjects?: unknown[];
}

interface MediaIndex {
  schema: 1;
  archiveId: string;
  entries: MediaEntry[];     // ~40 for v1
  builtAt: string;
}

interface Visibility {
  schema: 1;
  mediaId: string;
  hidden: boolean;
  deleted: boolean;
  rev: number;               // monotonic, for observability not for CAS
  updatedAt: string;
  reason: 'INGEST' | 'ORGANIZER' | 'REMOVAL_REQUEST';
}

interface VisSummary {          // derived, display-only, self-healing
  schema: 1;
  hiddenIds: string[];
  deletedIds: string[];
  builtAt: string;
}

interface AttendeeCodeRecord {
  schema: 1;
  algo: 'pbkdf2-sha256';
  iterations: number;        // 600000 — current OWASP guidance for PBKDF2-HMAC-SHA256
  salt: string;              // base64, 16 bytes
  hash: string;              // base64, 32 bytes
  codeLength: number;
  codeVersion: number;       // must match ArchiveConfig.codeVersion
  rotatedAt: string;
}

interface RemovalRecord {
  schema: 1;
  recordId: string;          // 16 random bytes, base64url
  mediaId: string;
  submittedAt: string;
  note?: string;             // <= 1000 chars, trimmed
  status: 'PENDING' | 'REVIEWED';
  reviewedAt?: string;
}

interface RateWindow {
  schema: 1;
  hits: number[];            // epoch ms, pruned to the trailing 60s, capped at limit + 1
}
```

`RemovalRecord`'s field set is the complete allowlist. There is no IP field, no user agent field, no header capture, no session identifier, and nothing derived from any of them. Requirement 5.6, 11.1.

### Why the index is immutable and visibility is not

The guidance was to keep the media index a single document. It is — but only for facts that never change. Mutation moved out, and here is the reasoning, because it is the one place this design deviates from the suggestion.

Netlify Blobs has no conditional write. `set` is unconditional; there is no if-match, no ETag precondition, no atomic increment. [Netlify's own documentation](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) is explicit that overlapping writes to the same object resolve as last-write-wins, that Blobs ships no concurrency control, and that applications needing safety there have to build their own locking. So read-modify-write on a shared document loses writes with no way to detect it. Now consider two concurrent operations on a 40-item index: the Organizer hides `QLK 012` while an Attendee's removal request hides `QLK 031`. Both read revision *v*, both write, one write survives. One of those two hides is silently gone. A lost hide means media stays visible after someone asked for it to come down. Under our priority order that outranks document-count tidiness.

The split:

- **`index`** — mediaId, type, label, order, dimensions, byte lengths. Written exactly once, by the Ingest_Script. No runtime route ever writes it, so there is nothing to clobber.
- **`vis/{mediaId}`** — hidden and deleted. One document per item, so hide, restore, delete, and removal-request writes for *different* items touch disjoint keys and cannot interfere at all. Two writes to the *same* item are inherently ordered by the operator's intent (a hide followed by a delete), and the last write is the correct one.
- **`vis-summary`** — a denormalized list of hidden and deleted ids. It is a shared document and therefore does have a lost-update window. That is acceptable because it is display-only and self-heals: it is rebuilt from the per-item documents after every mutation and on every Admin_View load, and it is never consulted by the gate. It backs the Admin_View's counts and pending-removal indicators. It does **not** decide which tiles the Archive_View emits — once grid thumbnails are inlined, emitting a tile *is* delivering bytes, so that decision needs the per-item strong read. See "Bandwidth shape" under Media Delivery.

**What the gate actually reads.** On a cold function instance, `gateMedia` performs **three** strongly-consistent reads per media request:

1. `config` — state, expiration, code version.
2. `index` — the entry, to confirm the Media_ID exists and carries the requested variant (chain step 4).
3. `vis/{mediaId}` — hidden and deleted (chain step 5).

An earlier draft of this document claimed two reads and justified it as "faster than reading the whole index." That was wrong on its own terms: step 4 requires the index. Three reads is the honest number, and the index is by far the largest of them at ~40 entries.

The index is the one document that can be cached, because it is immutable after ingest — the Ingest_Script is its only writer and no runtime route touches it. So a warm instance holds it in module scope, keyed by its `builtAt` value, with a **60-second TTL** so that a re-ingest is picked up without a redeploy. Cost: three reads cold, two warm.

The hard rule around that cache: **it holds only immutable data.** `config` and `vis` are never cached, at any layer, for any duration. A cached `config` would keep serving a disabled archive; a cached `vis` would keep serving an item someone asked to have taken down. Either is an authorization bypass wearing a performance costume. This is the same reasoning that puts `force-dynamic` on every route and keeps `unstable_cache` out of the protected surface — the index cache is the single exception, and it is an exception precisely because nothing about it can authorize anything.

`config` is a shared mutable document with the same lost-update property as `vis-summary`, but it has exactly one writer role (the Organizer, clicking serially in one browser), so we accept last-writer-wins and note it here rather than engineering around it.

### First-boot seeding

`ensureSeeded()` runs at the top of every request path that reads `config`. It is strictly create-if-absent and never overwrites.

1. If `config` is absent, write it: `state: 'LIVE'`, `expiresAt` from `FLASHBACK_EXPIRES_AT` or now + 12 days, `codeVersion: 1`, `eventName` from env.
2. If `secret/attendee-code` is absent and `FLASHBACK_ATTENDEE_CODE_SEED` is set, derive salt + PBKDF2 hash from it and write the record at `codeVersion: 1`.
3. If `secret/attendee-code` is absent and no seed env var is set, **fail closed**: force `state: 'DISABLED'` and surface a diagnostic on the Admin_View. An archive with no code must not be an archive with no lock.

Normal operation is that the Ingest_Script seeds the code and prints it, so the plaintext never needs to sit in a Netlify env var at all. The env path exists because Requirement 13.5 mandates it, and as a recovery route. Requirement 13.5, 13.6.

---

## Components and Interfaces

### Authorization: The Single Gate

One function decides everything. Every protected surface calls it and nothing else.

```ts
// lib/auth/gate.ts

export type Role = 'attendee' | 'organizer';

export type GateDenial =
  | { ok: false; status: 401; code: 'NO_SESSION' }
  | { ok: false; status: 401; code: 'SESSION_EXPIRED' }
  | { ok: false; status: 401; code: 'SESSION_INVALID' }
  | { ok: false; status: 403; code: 'ARCHIVE_DISABLED' }
  | { ok: false; status: 403; code: 'ARCHIVE_EXPIRED' }
  | { ok: false; status: 403; code: 'ROLE_INSUFFICIENT' }
  | { ok: false; status: 404; code: 'MEDIA_UNKNOWN' }
  | { ok: false; status: 404; code: 'MEDIA_HIDDEN' }
  | { ok: false; status: 404; code: 'MEDIA_DELETED' }
  | { ok: false; status: 503; code: 'STATE_UNREADABLE' };

declare const proofBrand: unique symbol;
export interface GateProof {
  readonly [proofBrand]: true;   // constructible only inside this module
  readonly role: Role;
  readonly mediaId: string;
  readonly variant: Variant;
  readonly entry: MediaEntry;
}

export type GateResult = { ok: true; proof: GateProof } | GateDenial;

export async function gateMedia(
  req: Request,
  mediaId: string,
  variant: Variant,
): Promise<GateResult>;

export async function gateView(req: Request): Promise<
  | { ok: true; role: Role; config: ArchiveConfig }
  | GateDenial
>;
```

#### The ordered chain

`gateMedia` evaluates in exactly this order and returns at the first failure. Requirement 2.2.

1. **Session.** Read `fb_o`, then `fb_a`. Verify HMAC. Verify `exp > now`. Verify `role` matches the cookie slot. For an attendee token, verify `payload.cv === config.codeVersion`. No valid token → `401 NO_SESSION` (or `SESSION_EXPIRED` / `SESSION_INVALID`, all 401).
2. **Archive state.** `config.state === 'LIVE'`, else `403 ARCHIVE_DISABLED`. Skipped for `role === 'organizer'` (Requirement 6.15, 8.6).
3. **Expiration.** `Date.now() < Date.parse(config.expiresAt)`, else `403 ARCHIVE_EXPIRED`. Skipped for `role === 'organizer'`.
4. **Existence.** `mediaId` present in `index` and the requested `variant` present on the entry, else `404 MEDIA_UNKNOWN`.
5. **Visibility.** `vis.deleted === false`, else `404 MEDIA_DELETED`. `vis.hidden === false`, else `404 MEDIA_HIDDEN` — skipped for `role === 'organizer'`, which is how the Organizer previews hidden items (Requirement 6.15).

Steps 1–3 are `role`-aware, and the *order* is fixed regardless: a request with no session never learns whether the archive is disabled, and a request with an expired session never learns whether a Media_ID exists. Hidden and deleted both surface as 404, indistinguishable from a Media_ID that never existed. Requirement 2.4, 2.7.

Any thrown error or unparseable document short-circuits to `503 STATE_UNREADABLE`. **Fail closed, always.** There is no code path where a read failure results in serving bytes.

Read cost is three strongly-consistent documents cold and two warm — `config` and `vis/{mediaId}` every time, `index` from a `builtAt`-keyed module-scope cache with a 60-second TTL. Only the immutable document is cached; see "What the gate actually reads" under Data Models for why that boundary is not negotiable.

`gateView` is the same chain minus steps 4 and 5, used by `/archive` and `/admin`. When `/archive` renders inline grid thumbnails it then runs the full five-step chain once per candidate item, because emitting an inline thumbnail delivers bytes and therefore has to clear the same gate a Media_API request would.

#### Why bypass is a type error

`lib/blobs/media.ts` does not export the store. It exports one function:

```ts
// lib/media/serve.ts — the only module permitted to import lib/blobs/media
export async function serveMedia(proof: GateProof, range: string | null): Promise<Response>;

// Same proof requirement, different output shape: a base64 data URI for inlining
// into an authenticated HTML response. Rejects any proof whose variant is not 'grid'.
export async function inlineThumbnail(proof: GateProof): Promise<string>;
```

A `GateProof` cannot be constructed outside `lib/auth/gate.ts` (unique-symbol brand), and these two functions are the only ones with access to the media store. To serve a byte you must hold a proof; to hold a proof you must have run the chain. That holds identically for the inline path — a `data:` URI in the grid HTML is media bytes, so it requires a proof exactly as a `206` response body does. Backed by an ESLint `no-restricted-imports` zone forbidding `lib/blobs/media` from every path except `lib/media/serve.ts`, so the invariant fails the build rather than a review.

The Removal_API and Admin_API reuse the same session verification through `gateView` / `withOrganizer`, so Requirement 5.8, 7.2, 7.3, and 7.6 are the same code as Requirement 2.2. There is one chain, in one file.

#### Consent seam

`gateMedia` evaluates visibility through a small array of predicates over `(entry, vis, role)`. A future per-subject consent check appends one predicate and reads `MediaEntry.subjects`, which already exists as a reserved field. No call site changes, no new store, no signature change. That is the entire extensibility provision — the consent system itself is explicitly out of scope.

---

### Sessions

#### Token format

```
fb1.<payload-b64url>.<sig-b64url>
```

`payload` is compact JSON, `sig` is HMAC-SHA256 over the ASCII string `fb1.<payload-b64url>` keyed by `FLASHBACK_SESSION_KEY` (32 random bytes, base64-encoded in env).

```ts
interface SessionPayload {
  r: 'a' | 'o';   // role
  cv: number;     // code version at issue time; attendee only, 0 for organizer
  iat: number;    // epoch seconds
  exp: number;    // epoch seconds, iat + 43200 (12 hours)
  jti: string;    // 12 random bytes base64url — per-session id, unused in v1
}
```

Cookies: `fb_a` for attendees, `fb_o` for organizers. Both `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`. Requirement 1.4, 7.4.

Two separate cookie names *and* a role field in the signed payload. Either alone would be sufficient; both together mean an attendee token placed in the `fb_o` slot fails the role check, and a forged `fb_o` fails the signature. Requirement 7.5 holds structurally.

No new dependency: `crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])` plus `crypto.subtle.sign`. Comparison uses a portable constant-time helper rather than `node:crypto.timingSafeEqual`, so the same module runs in the Deno edge runtime for middleware:

```ts
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;   // length is not secret here
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
```

#### Verification outcomes

| Condition | Treatment | Status from Media_API |
| --- | --- | --- |
| Cookie absent | no session | 401 |
| Malformed / wrong prefix / not 3 segments | no session | 401 |
| Signature mismatch | no session (Requirement 7.9) | 401 |
| Valid signature, `exp <= now` | no session (Requirement 14.16) | 401 |
| Valid signature, `r` disagrees with cookie slot | no session | 401 |
| Attendee token, `cv !== config.codeVersion` | no session (Requirement 6.7) | 401 |
| Valid | session | continue chain |

Every failure collapses to "this request carries no session." There is no distinct status for tampering, so probing tells an attacker nothing.

#### Rotation invalidates prior sessions

`ArchiveConfig.codeVersion` starts at 1 and increments on every rotation, in the same write that persists the new `AttendeeCodeRecord`. Attendee tokens carry `cv` at issue time; the gate compares it against the current `codeVersion` on a strong read. After a rotation, every previously issued attendee token mismatches and is treated as carrying no session. Requirement 6.7.

Organizer sessions carry `cv: 0` and are never compared, so rotating the attendee code does not lock the Organizer out mid-task.

Write order for rotation matters: write the `AttendeeCodeRecord` first, then `config` with the bumped `codeVersion`. If the second write fails, the old code still validates and old sessions still work — degraded but coherent. The reverse order would leave a window with no valid code at all.

---

### Access Flow

#### Code shape and generation

Alphabet: `23456789ABCDEFGHJKMNPQRSTUVWXYZ` — 31 characters, excluding `0 O 1 I L`. Default length 10, permitted range 8–12. Requirement 1.7.

At length 10 that is 31^10 ≈ 8.2 × 10^14, about 49.5 bits. Not a password. It is defended by four things together: PBKDF2 at 600,000 iterations making each guess cost roughly 300 ms of server CPU, the sliding-window rate limiter, a 12-day archive lifetime, and the Organizer's disable control. Called out plainly because a reader should not mistake a transcribable code for a strong secret.

600,000 iterations is current OWASP Password Storage guidance for PBKDF2-HMAC-SHA256, up from the 210,000 an earlier draft of this document specified. The correction is worth taking even though hash cost is the *weakest* of those four defenses — 49.5 bits of entropy is what actually makes the search infeasible, and the rate limiter and the disable control are what handle an attacker who is trying anyway. Raising the iteration count roughly triples per-attempt CPU, which is a real cost only to an attacker making many attempts and a ~200 ms addition for the one legitimate attendee submission. Well inside the 60-second synchronous function limit, with three orders of magnitude to spare; Requirement 13.10 has the deployed check confirm that limit by measurement regardless.

Generation draws from `crypto.getRandomValues` with rejection sampling (reject bytes ≥ 248 before `% 31`) so the distribution is uniform — modulo bias on a 31-symbol alphabet is real and cheap to avoid.

#### Verification

```
normalize(input) = input.replace(/\s+/g, '').toUpperCase()
```

Strips leading, trailing, and internal whitespace, then uppercases. Requirement 1.6. Applied before hashing, so `qlk 2 f7 hj kmn` and `QLK2F7HJKMN` are the same submission.

`POST /api/access` in order:

1. Rate-limit check on `scope: 'access'`. Over limit → `429` with `Retry-After: 60`. Requirement 1.9.
2. `ensureSeeded()`, then read `config` (strong).
3. `config.state !== 'LIVE'` → `403`. Requirement 6.4.
4. `now >= expiresAt` → `403`. Requirement 8.3.
5. Read `AttendeeCodeRecord`. Derive PBKDF2-HMAC-SHA256 at the record's `iterations` (600,000 for records written by this version), 32-byte output over `normalize(input)` and the stored salt. Compare with `timingSafeEqual`. Requirement 1.3. Iterations come from the record rather than a constant, so a record seeded under an older count still verifies and a rotation upgrades it.
6. Mismatch → record a rate-limit hit, respond `401` with body `{"error":"INVALID"}` and no `Set-Cookie`. Requirement 1.5.
7. Match → mint `fb_a` with `cv: config.codeVersion`, `303` redirect to `/archive`. Requirement 1.4, 1.11.

Steps 3 and 4 come before the hash comparison, so a disabled or expired archive returns 403 for the correct code too, and cheaply.

The response body on failure is a fixed string. No hint about length, no character feedback, no timing branch on the code content. Requirement 1.5.

`POST /api/admin/session` is the same shape against `FLASHBACK_ORGANIZER_SECRET` read from env, compared with `timingSafeEqual` against the raw env value — no blob read, no persisted copy. Requirement 7.1, 13.6. It carries its own rate-limit scope at 5 failures per 60s.

---

### Media Delivery and Range Streaming

#### Route

`GET|HEAD /api/media/[id]?v=full|grid|poster`. Default variant `full`. Every variant goes through `gateMedia`, so the poster frame and the grid thumbnail are exactly as protected as the full derivative. `head` is not accepted here; an unrecognized `v` value is a `404` from chain step 4, not a fallback to `full`. Requirement 2.1, 2.10.

Response headers on every 2xx:

```
Content-Type:   <from index>
Content-Length: <exact bytes in this response>
Cache-Control:  private, max-age=60
Vary:           Cookie
Accept-Ranges:  bytes          (video only)
X-Content-Type-Options: nosniff
```

Requirement 2.8, 3.2, 12.6. `HEAD` returns the identical header set with a zero-length body.

**Cache posture: `private, max-age=60` on media bytes, `private, no-store` on authenticated HTML.**

An earlier draft used `no-store` on everything and argued that the extra bandwidth was a deliberate cost worth paying. Half of that reasoning survives and half of it was solving the wrong problem, so it is worth separating the two.

The part that was right: a shared cache must never hold a media byte. A CDN node or a corporate proxy holding a photograph is an unauthenticated copy of protected data sitting outside the gate, reachable by whoever else hits that node. That is the actual security requirement, and `private` is the directive that states it. We emit `private` and we emit **no** `public`, no `s-maxage`, and no other shared-cache directive — Requirement 12.8, checked against the deployed site by Requirement 14.23.

The part that was wrong: `no-store` does not only exclude shared caches, it also excludes the requesting attendee's own browser, and that buys nothing. That attendee already passed the gate, already has the bytes decoded in a `<video>` element or an `<img>`, and can save the file with the OS. Forbidding their private cache does not reduce their access by one byte. What it does is force every revisit and every seek back through a function invocation — which, on a credit-metered plan, spends the Organizer's allowance to protect against nothing. `max-age=60` permits exactly one thing: the browser that made the request reusing its own copy for a minute.

`private, no-store` stays on authenticated HTML — every Archive_View and Admin_View response. Requirement 12.9. Those responses carry the Media_ID index, the inline grid thumbnails, and, in the render immediately after a rotation, the Attendee_Code plaintext. A cached page is a cached list of what exists and who can reach it, and unlike a photograph the page is *cheap to regenerate*, so there is no cost argument on the other side.

**The bounded consequence, stated plainly.** An attendee who fetched an item before it was hidden or deleted can still view their private copy for up to 60 seconds afterward. Requirement 2.17 records that as accepted, not as a bug to be discovered later. It is bounded three ways: it applies only to that one browser, only to items it already fetched, and only for 60 seconds. Archive-level controls are unaffected — the disable control and the Expiration_Timestamp gate *new* requests, and the Media_API re-evaluates `state`, `expiresAt`, `hidden`, and `deleted` on every one of them (Requirement 2.18), so Requirement 14.10's five-second bound on the disable control still holds. Sixty seconds is the number precisely because the window is a liability: long enough that a video seek or a lightbox re-open is free, short enough that a removal request takes visible effect while the person who filed it is still looking at the page.

`If-Range`, `If-None-Match`, `ETag`, and `Last-Modified` are still not implemented. With a 60-second freshness lifetime and no validator, the browser reuses its copy for a minute and then refetches outright. That costs one extra full transfer versus a `304`, and in exchange there is no validator a client can use to argue a cached copy should live longer than the header says.

#### Bandwidth shape

Forty photos at ≤1 MB is 40 MB per full gallery view, so the grid has never been served from the full derivative. The question is what the grid *is* served from, and the credit model answered it differently than bandwidth alone would have.

**The photo variant set, resolved.** There are two photo variants, not three:

- `full` — longest edge ≤2400 px, ≤1 MB. Requirement 4.2. Fetched through the Media_API on lightbox open.
- `grid` — the Grid_Thumbnail. Longest edge 400 px, target 20–30 KB. Base64-embedded directly into the authenticated `/archive` HTML as an Inline_Thumbnail. Requirement 2.10.

An earlier draft had a third variant, `thumb` at 640 px and ~60–90 KB, fetched per tile through the Media_API. `thumb` is **removed**, not retained alongside `grid`. Its only consumer was the grid; with the grid inlined, nothing requests it, and keeping it would mean a third encode per photo at ingest, a third blob per photo to delete on delete-all, and a variant in the union that no route reaches. `grid` remains addressable through `?v=grid` because the Admin_View needs it for hidden-item previews (Requirement 6.15), which must go through the Media_API.

**Why inline.** Every tile fetched through the Media_API is a function invocation, because every byte has to pass the gate and therefore nothing can be a static asset. A 40-photo grid cost ~41 invocations per view. Embedding the thumbnails in the HTML the gate already produced collapses that to **1**. Requirement 13.8 caps the grid at 2 invocations; this lands at 1, or 2 if you count the Featured_Video's poster frame, which is not part of the photograph grid and which must stay on the Media_API because Requirement 2.10 permits inlining for a Grid_Thumbnail only.

**The size arithmetic**, since Requirement 2.14 caps the response at 5 MB and the Netlify buffered ceiling is 6 MB:

| | 25 KB/thumb | 30 KB/thumb (worst case) |
| --- | --- | --- |
| 40 thumbnails, raw | 1,000 KB | 1,200 KB |
| after base64 (×4/3) | 1,333 KB | 1,600 KB |
| `data:` URI prefixes (23 B × 40) | ~1 KB | ~1 KB |
| markup, Flight payload, inline font CSS | ~200 KB | ~250 KB |
| **total** | **~1.5 MB** | **~1.8 MB** |

That leaves 3.2–3.5 MB of headroom under the 5 MB ceiling and 4.2–4.5 MB under the 6 MB cap. At 60 items — the upper bound `arbMediaIndex` generates, and a plausible second event — worst case is ~2.6 MB, still clear. The numbers fit at 400 px, so the dimensions stand; had they not, the first lever would have been 320 px rather than a lower JPEG quality, because quality artifacts at thumbnail scale read as a bad photograph rather than a small one.

Two caveats on that table. It counts **uncompressed** bytes: base64 of already-compressed JPEG gains only a few percent under gzip or brotli, so transfer compression is not headroom we can spend. And the ceiling is enforced at ingest, not at render — the Ingest_Script sums the assembled base64 length and **fails the run** with a report if it exceeds 4 MB, so Requirement 2.14 is a build-time guarantee rather than something the render path discovers and degrades around.

**Emitted only behind the gate.** Inline thumbnails exist only in a response that passed the chain. A request with no valid session gets a redirect or a 401 whose body carries zero `data:` URIs and zero Media_IDs (Requirement 2.15, verified by 14.24), and a request at or after the Expiration_Timestamp gets the ended state, which renders no grid at all (Requirement 2.16). One implementation constraint follows from 14.24 being a structural check rather than an allowlist: the grain overlay's SVG `data:` URI must live in the external stylesheet, never in an inline `<style>` block or a `style=` attribute, so that "zero `data:` URIs in an unauthenticated HTML body" stays literally true and testable.

**What the gate has to do differently.** Emitting an inline thumbnail *is* delivering bytes, so the decision to emit one cannot come from `vis-summary`. The summary is eventually correct, and the old arrangement tolerated that because a stale tile's bytes were independently gated at Media_API time and would simply 404. Inlining removes that second gate. So the Archive_View render runs the full five-step chain per candidate item — 40 strong `vis/{mediaId}` reads, issued with bounded concurrency, adding a few hundred milliseconds to a page that is already dynamic. That is the correct price, and paying it in blob reads rather than in function invocations is the whole point.

**What is lost.** No spin on this:

- **No lazy loading.** `loading="lazy"` is meaningless on a `data:` URI — the bytes are already in the document. `decoding="async"` still applies, and intrinsic `width`/`height` from the index still prevent reflow.
- **One larger payload.** ~1.5 MB of HTML instead of ~30 KB of HTML plus lazily-fetched thumbnails.
- **Slower time-to-first-byte on the grid.** The server reads 40 blobs and base64-encodes them before the document is complete.
- **The whole grid is paid for even if nobody scrolls.** An attendee who opens `/archive` and closes it downloads all 40 thumbnails. Under lazy loading they would have downloaded two rows.

Against that: 41 invocations become 1, and the byte comparison is less lopsided than it looks, because 400 px thumbnails are smaller than the 640 px ones they replace. A full-scroll grid view drops from ~3 MB to ~1.5 MB; a no-scroll view rises from ~300 KB to ~1.5 MB. Bytes are roughly a wash. Invocations are not, and invocations are what the credit model bills.

**Revised ceiling.** 300 attendees × 2 visits × (1.5 MB grid HTML + ~8 opened photos at 1 MB + one 18 MB video) ≈ **16 GB**. Essentially unchanged from the earlier estimate, because the dominant terms — the video and the opened photos — were already once per visit. `max-age=60` removes re-downloads on revisit and on seek, and inlining trades thumbnail bytes for HTML bytes; neither moves the total much. The honest summary is that these two changes buy **invocations, not bandwidth**, and per the metered-usage subsection above we do not know the conversion rate from either to credits. Treat 16 GB as an order-of-magnitude check against the historically-documented 100 GB Blobs allowance, not as proof the archive stays inside 300 credits.

#### The Range handler

Netlify Blobs has **no server-side range read.** `store.get(key, { type })` supports `'stream'`, `'arrayBuffer'`, `'blob'`, `'text'`, `'json'` — and nothing that accepts a byte offset. So any partial response is produced by fetching the object and slicing it locally. Stating that plainly because it drives the whole shape of this handler.

Four cases:

**1. No `Range` header.** Stream straight through. `store.get(key, { type: 'stream' })` gives a `ReadableStream` that becomes the `Response` body directly. One backend fetch, peak memory a few hundred KB, `200`, `Content-Length` from the index. An 18 MB video sits under the 20 MB streamed-response cap.

**2. `Range: bytes=0-` (open-ended from zero).** This is what browsers send on initial video load, and treating it as a real partial read would mean fetching 18 MB to return a 4 MB slice. Instead, satisfy it in full: stream the whole object with `206` and `Content-Range: bytes 0-<N-1>/<N>`. One backend fetch, still under the streamed cap, and seeking still works because a real seek sends a bounded range.

**3. Bounded `Range: bytes=s-e` reaching past the head window.** Fetch `arrayBuffer` on `full`, slice, respond `206`.

**4. Bounded `Range: bytes=s-e` lying entirely inside `[0, 256 KB)`.** Served from the `head` blob. Safari and iOS open a video with a tiny bounded probe — `bytes=0-1` is the common one — and under the three-case logic that landed in case 3, fetching the whole 18 MB object to return two bytes. That is exactly the amplification the rest of this handler is built to avoid, and it happens on *every* iOS video load, which is most of them.

So the Ingest_Script stores the first 256 KB of each video as a separate small object at `media/{mediaId}/head`. Because `-movflags +faststart` places the moov atom ahead of mdat, the metadata a player probes for is inside that window, and a 256 KB fetch answers the probe. Blobs still has no server-side range read — this does not fix that, it just gives the handler a smaller object to slice, which is the only lever available. `head` is never requestable: it carries no separate gate decision, because it is a byte-identical prefix of the `full` variant the gate already approved for this request.

Two details that matter more than they look:

- **`Content-Range` describes the full object, not the head.** `bytes 0-1/18874368`, never `bytes 0-1/262144`. A player that believes the file is 256 KB long will not seek past it, and the bug presents as "seeking is broken on iPhone" three days after handoff.
- **A range that starts inside the head and runs past it** is clamped to the head boundary and answered from `head` — the same "a server may return fewer bytes than requested" rule that `RANGE_MAX_BYTES` already relies on. The client asks for the rest and that request lands in case 3.

If the head object is absent (a video ≤256 KB, where ingest skips it as pointless), case 4 falls through to case 3, which is correct because the whole object is small anyway.

```ts
// Returns null for a syntactically invalid header (treat as absent, per RFC 9110).
// Returns 'unsatisfiable' when start >= size.
function parseRange(header: string, size: number):
  | null
  | 'unsatisfiable'
  | { start: number; end: number; openEnded: boolean }
```

Rules:

- Single range only. A multi-range header (`bytes=0-99,200-299`) is answered with `200` and the full object — permitted, and it avoids implementing `multipart/byteranges`.
- Unit other than `bytes` → treat the header as absent.
- Suffix form `bytes=-500` → last 500 bytes.
- `start >= size` → `416` with `Content-Range: bytes */<size>`.
- `end` clamped to `size - 1`.
- Served length clamped to `RANGE_MAX_BYTES = 4 MB`. A server may return fewer bytes than requested; `Content-Range` describes exactly what was sent, and the client asks for the rest. This keeps every partial response an order of magnitude below the 6 MB function payload cap, so we are safe even if the platform does not classify a given response as streamed.
- `Content-Range` always describes the bytes actually in the body against the **full** object length, and the body is always a contiguous subrange of what was requested — never a byte outside it. Requirement 3.1. The `head` object never appears in a `Content-Range` denominator.
- `If-Range`, `If-None-Match`, and ETags are not implemented. See the cache posture note above: with a 60-second freshness lifetime and no validator, there is nothing to revalidate against.

Memory: worst case is case 3 on the video, an 18 MB `ArrayBuffer` in a function with a 1 GB ceiling. Fine. The honest cost is backend transfer amplification — each case-3 range pulls the whole object from the blob backend. With one video, case 2 covering initial playback, case 4 absorbing the iOS probes, and `max-age=60` making a repeated seek free, that is acceptable. If it ever is not, the fix is a pre-chunked ingest (store the video as N fixed-size parts and range-read only the parts that intersect), which is a contained change behind `serveMedia` and explicitly not in v1 — the `head` object is that idea applied to the one chunk that gets requested on every single load.

Before responding, `serveMedia` asserts the fetched object's length equals the recorded byte length — `entry.variants[variant].byteLength` in cases 1–3, `entry.variants.head.byteLength` in case 4. A mismatch means a truncated or half-written blob, and returns `503` rather than a corrupt partial. `Content-Length` is then always trustworthy.

**Fallback knob.** If the deployed check for a full 18 MB video response fails on the free tier, `MAX_VIDEO_BYTES` in the ingest config drops to 5 MB and the video is re-encoded. Documented so the ship is never blocked on this, and it introduces no new service. Requirement 13.7.

#### Player

```tsx
const videoRef = useRef<HTMLVideoElement>(null);

// React does not reliably reflect `muted` into the DOM property through SSR
// hydration, so set it imperatively once. This establishes the initial state
// without pinning it, leaving the volume control free.
useEffect(() => {
  if (videoRef.current) videoRef.current.muted = true;
}, []);

<video
  ref={videoRef}
  src={`/api/media/${featured.mediaId}`}
  poster={`/api/media/${featured.mediaId}?v=poster`}
  controls
  defaultMuted
  playsInline
  preload="metadata"
  controlsList="nodownload noplaybackrate"
  disablePictureInPicture
/>
```

No `autoplay`. Muting needs both halves, and the reason is a genuine React wart rather than a style preference. `muted` is a DOM *property* that React does not consistently set as an attribute during server rendering, so a plain `muted` JSX attribute on a server-rendered `<video>` can arrive unmuted — the element plays at the room's actual volume the moment someone hits play. Requirement 3.3 depends on that not happening, and the failure is silent in development and loud in a rideshare. So: `defaultMuted` on the element, which React does emit as the `muted` HTML attribute, plus an imperative `videoRef.current.muted = true` in a mount effect for the hydration path.

The original reasoning about not using a fixed `muted` prop still holds, and this is why the fix is shaped this way: a controlled `muted={true}` would let React reassert `false → true` on re-render and fight the user's own volume changes, which Requirement 3.4 forbids. `defaultMuted` plus a one-shot effect sets the initial state and then never touches it again. Native controls give seek and volume for free and are keyboard-operable and screen-reader labelled, which is why we are not building a custom player. Requirement 3.3, 3.4, 3.6.

**`next/image` is forbidden for Media_Items.** On Netlify it routes through the Netlify Image CDN, which fetches and caches transformed output outside our authorization gate — a public cache of protected bytes. `next.config.ts` sets `images: { unoptimized: true }` and a lint rule bans `next/image` imports in the archive tree. Plain `<img>` only.

---

### Admin API

Every route is `POST`, wrapped by one helper:

```ts
export function withOrganizer(
  handler: (req: Request, ctx: { config: ArchiveConfig }) => Promise<Response>,
): (req: Request) => Promise<Response>;
```

`withOrganizer` performs, in order: verify `fb_o` (401 on failure), reject a request bearing only `fb_a` (403), check `Origin` against the site origin (403 on mismatch or absence), then `ensureSeeded()` and read `config`. No handler body runs, and therefore no write occurs, unless all of it passes. Requirement 7.2, 7.3, 7.6, 7.7.

Site origin comes from `FLASHBACK_SITE_ORIGIN` if set, otherwise Netlify's `process.env.URL`.

| Route | Body | Effect |
| --- | --- | --- |
| `POST /api/admin/session` | `{ secret }` | Mint `fb_o`. Not wrapped — this is the login. |
| `POST /api/admin/session/logout` | — | Clear `fb_o` |
| `POST /api/admin/state` | `{ state: 'LIVE' \| 'DISABLED' }` | Write `config.state`. Requirement 6.3, 6.5 |
| `POST /api/admin/expiration` | `{ expiresAt: string }` | Write `config.expiresAt`, past values accepted. Requirement 6.8, 8.7 |
| `POST /api/admin/code/rotate` | — | New code, new record, bump `codeVersion`, return plaintext once. Requirement 6.6, 6.7 |
| `POST /api/admin/media/[id]/visibility` | `{ hidden: boolean }` | Write `vis/{id}`, rebuild summary. Requirement 6.9, 6.10 |
| `POST /api/admin/media/[id]/delete` | `{ confirm: string }` | Delete every variant's bytes, set `deleted`. Requirement 6.11 |
| `POST /api/admin/media/delete-all` | `{ confirm: string }` | Same for every entry. Requirement 6.12 |
| `POST /api/admin/removals/[recordId]/review` | `{ status }` | Update status, leave `hidden` true. Requirement 6.14 |

#### Destructive confirmation

The delete routes require `confirm` to equal a server-computed string, compared exactly:

- single: `DELETE <label>` — e.g. `DELETE QLK 017`
- all: `DELETE ALL <n> ITEMS` — `n` from the current index

Any mismatch, absence, or wrong-case value → `400`, and **zero blob deletions**. The check runs before the media store handle is obtained, so a failed confirmation cannot partially delete. The UI requires the Organizer to type the string; there is no one-click delete. Requirement 6.13.

Delete order per item: mark `vis.deleted = true` first (strong, immediately effective, gate now 404s), then remove the bytes. If the byte removal fails, the item is already unreachable and the delete is retryable. The reverse order would leave a window where the index claims an item exists but its bytes are gone.

Delete-all iterates items sequentially and reports per-item outcomes. With the resolved variant set — two blobs per photo (`full`, `grid`) and three per video (`full`, `poster`, `head`) — forty photos and one video is ~83 deletes, well inside the 60s execution budget. Deletion enumerates the variants actually declared on each index entry rather than a hardcoded list, so adding or removing a variant does not leave orphan bytes behind. If the budget ever were tight, the response reports how far it got and the operation is idempotent on retry.

#### Rotation display

The new plaintext is in the rotate response body and rendered once. It is never written to a blob, never logged, and the page holding it is `Cache-Control: private, no-store`. Reloading the Admin_View does not show it again. Requirement 6.6.

The Admin_View also renders the distribution text for the Organizer to copy:

```
QLICK QRAVE — private archive
<siteOrigin>
code: <active code>
expires: <expiresAt, formatted>
```

Since the active plaintext is not recoverable after the rotation response, this text shows the code only in the render immediately following a rotation; otherwise it shows a placeholder with a "rotate to get a fresh code" affordance. That is the honest consequence of not storing the plaintext, and it is the right trade. Requirement 15.3.

#### Admin surface

Server-rendered, no client data fetching. Reads `config`, `index`, all `vis/{id}` documents (40 strong reads on an admin page is fine and it rebuilds `vis-summary` as a side effect), and lists `removals/` to count `PENDING`. Displays event name, state, expiration, photo count, video count, and pending removal count. Requirement 6.1.

Hidden items render with a visible `HIDDEN` marker and a live preview through the Media_API at `?v=grid`, authorized by the organizer session — which is exactly what the `role === 'organizer'` skip in gate step 5 exists for, and what Requirement 6.15 asks for literally. Visible items inline their grid thumbnail the same way `/archive` does, so a normal admin load is one invocation plus one per hidden item rather than one per item. The Admin_View response carries `Cache-Control: private, no-store` (Requirement 12.9) for the same reasons the Archive_View does, with the rotation plaintext added to the list.

Every mutation is a `<form>` posting to its route, then a redirect back to `/admin`. No client-side state, no optimistic UI, nothing to desync.

---

### Removal Requests

`POST /api/removal`, body `{ mediaId: string, note?: string }`.

1. `gateView(req)` — no valid session → `401`. Requirement 5.8.
2. Rate-limit `scope: 'removal'`, limit 20 accepted per 60s → `429`. Requirement 5.9.
3. Validate: `mediaId` must exist in the index. `note`, if present, is trimmed and must be ≤1000 characters after trimming; longer → `400`. Requirement 5.2.
4. **Construct the record from an explicit allowlist**, never by spreading the parsed body:

```ts
const record: RemovalRecord = {
  schema: 1,
  recordId: randomId(16),
  mediaId: entry.mediaId,          // from the index, not from the payload
  submittedAt: new Date().toISOString(),
  ...(note ? { note } : {}),
  status: 'PENDING',
};
```

Extra fields in the payload are structurally unreachable — they are never read, so they cannot be stored. Requirement 5.3. No IP, no user agent, no `Referer`, no header capture, no session id, nothing derived from the request beyond the two accepted fields. Requirement 5.6, 11.1.

5. **Write `vis/{mediaId}` with `hidden: true` before writing the record, and both before responding.** The strong store makes it immediately effective, so a media request issued the instant the response lands already returns 404. Requirement 5.4.
6. Rebuild `vis-summary`, write the record, respond `200 { ok: true, hidden: true }`.
7. The UI replaces the tile in place with a confirmation: the item is already hidden and the Organizer will review. Requirement 5.7.

The hide happens whether or not the record write succeeds. If the record write fails we return `200` with the hide in place and log the failure — losing the audit record is bad, leaving the media visible is worse.

Marking a record reviewed changes `status` only. It never touches `vis`. Restoring is a separate, deliberate Organizer action. Requirement 6.14.

---

### Rate Limiting

No Redis, no external service, no atomic counter primitive. Netlify Blobs is the only state store and it offers no increment and no conditional write. So this is a best-effort deterrent, and the design says so out loud rather than implying robustness it does not have.

#### Mechanism

Sliding window in one small document per (scope, client).

```
key:   arch/{archiveId}/rl/{scope}/{ipHash}
value: { schema: 1, hits: number[] }   // epoch ms
```

`ipHash = base64url(HMAC-SHA256(FLASHBACK_SESSION_KEY, `${ip}|${scope}|${utcDate}`))[0..21]`

The IP is never stored. The hash is salted with the UTC date, so the key is not a stable identifier across days and cannot be used to correlate a visitor over time. Requirement 5.6, 11.1.

Client IP from `x-nf-client-connection-ip` (set by Netlify's edge), falling back to the first entry of `x-forwarded-for`. `x-forwarded-for` is client-spoofable, so the Netlify header is strongly preferred and the fallback exists only for local development.

Check:

1. Read the document (strong, by store choice).
2. Prune `hits` to entries within the trailing 60,000 ms.
3. `hits.length >= limit` → `429` with `Retry-After: 60`.
4. Otherwise proceed; on a countable event, append `now`, cap the array at `limit + 1`, write back.

A true sliding window, not fixed buckets. Fixed 60s buckets would allow up to 2× the limit across a boundary, which would not actually satisfy "within a 60-second window."

| Scope | Limit / 60s | Counted event | Requirement |
| --- | --- | --- | --- |
| `access` | 10 | failed submissions only | 1.8, 1.9 |
| `removal` | 20 | accepted requests | 5.9 |
| `admin-login` | 5 | failed submissions only | design addition |

#### Limitations, stated plainly

- **Lost updates.** Concurrent requests from one IP read the same array and both write; one append is lost. Under burst load the limiter undercounts. There is no CAS to fix this on the free tier.
- **Regional writes.** Blob writes are globally visible but the check-then-write sequence is not atomic across regions, widening the same window.
- **Per-IP only.** Any attacker with a handful of addresses walks around it. It stops a script pointed at one IP, nothing more.
- **Key accumulation.** Blobs has no TTL. Keys are pruned lazily on read and swept on Admin_View load (`list({ prefix: 'rl/' })`, delete documents whose newest hit is older than 5 minutes). A determined attacker across many IPs can still inflate the store; the answer to that is the disable control, not the limiter.

The real defenses against code brute force are the ~49.5 bits of code entropy, the PBKDF2 cost per attempt (600,000 iterations, roughly 300 ms of server CPU), the 12-day archive lifetime, and an Organizer who can kill access in one click. Entropy is doing most of that work; the hash cost and the limiter raise the floor, and neither is the wall.

---

### Ingest Pipeline

`npm run ingest -- ./photos [options]`, a standalone `tsx` script under `scripts/ingest/`. It never runs on Netlify.

#### Authentication to the production store

Outside the Netlify runtime, `getStore` needs explicit credentials:

```ts
const meta = getStore({
  name: 'flashback-meta',
  siteID: requireEnv('NETLIFY_SITE_ID'),
  token: requireEnv('NETLIFY_API_TOKEN'),
  consistency: 'strong',
});
```

Credentials live in `.env.ingest.local`, which is in `.gitignore` alongside `.env*.local`. The script refuses to start if either variable is missing and prints the variable names it wants. Requirement 4.10.

Local `netlify dev` uses a sandboxed local store and cannot see production blobs. That is a fact of the platform, not a bug, and it is precisely why Requirement 14 mandates verification against the deployed site.

#### Per-file flow

```
discover → classify → skip RAW → process → verify → write bytes → collect entry
                                                                       ↓
                                    (after all files) write index → seed code if absent
```

1. **Discover.** Non-recursive read of the target directory. Photos: `.jpg .jpeg .png .heic .heif .webp .tif .tiff`. Video: `.mp4 .mov .m4v`. RAW (skipped with a report): `.cr2 .cr3 .nef .arw .orf .rw2 .raf .dng .srw .pef`. Requirement 4.5. Anything else is ignored with a note.
2. **Never touch the source.** Everything is read-only: `fs.readFile` / `spawn ffmpeg -i`. No in-place operation exists in the script, and there is no write path to the input directory. Requirement 4.1.
3. **Photos, via sharp.**
   - `rotate()` first, with no argument — applies EXIF orientation to the pixels so that discarding EXIF does not flip the image.
   - `resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })` → longest edge ≤2400. Requirement 4.2.
   - `.jpeg({ quality: q, progressive: true, chromaSubsampling: '4:2:0', mozjpeg: true })` with a quality ladder `84 → 78 → 72 → 66 → 60`, stopping at the first output ≤1 MB. If 60 still exceeds it, step the longest edge down to 2000 then 1800 and retry the ladder. Requirement 4.2. JPEG rather than WebP or AVIF for universal compatibility and a metadata story we can verify with standard tools; the encoder is one line to change later.
   - `grid` (the Grid_Thumbnail): the same pipeline at `resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })`, `.jpeg({ quality: 72, progressive: false, chromaSubsampling: '4:2:0', mozjpeg: true })`, with a quality ladder `72 → 66 → 60` stopping at the first output ≤30 KB. Progressive encoding is off here because it buys nothing at 400 px and adds bytes. A 400 px JPEG at quality 72 lands at 20–30 KB for typical low-light rave frames; the ceiling is enforced rather than assumed, because the inline payload budget in Requirement 2.14 depends on it.
   - After the run, sum `ceil(4/3 × byteLength)` across every `grid` variant plus a 300 KB allowance for markup and Flight payload. **If the total exceeds 4 MB, fail the run** with the computed size and a suggestion to lower the grid dimension. That is how Requirement 2.14's 5 MB response ceiling becomes a build-time guarantee instead of a production surprise.
   - **`withMetadata()` is never called.** sharp drops all metadata by default; calling it would put some back.
   - ICC handling: convert to sRGB and embed nothing. An sRGB-tagged file is not private data, but a custom camera profile is a camera fingerprint, so we normalize instead of preserving.
4. **Metadata stripping is verified, not assumed** — for **every** derivative, on the same path, with no exceptions. `full`, `grid`, and the video `poster` each go through both checks independently. A Grid_Thumbnail is a real derivative of a real photograph, and a 400 px copy of a face carries the same GPS coordinate and the same `XMP-mwg-rs` region as the 2400 px copy; "it's only a thumbnail" is exactly the reasoning that leaks one. After encoding, each derivative buffer is re-read twice:
   - `sharp(buf).metadata()` must report `exif`, `iptc`, `xmp`, and `icc` all undefined.
   - `exiftool -j -G` on the buffer must return a tag set that is a subset of a fixed allowlist: `SourceFile`, `ExifToolVersion`, and the `File:*` / `JFIF:*` groups (dimensions, bit depth, color components, encoding). Any tag in `EXIF`, `GPS`, `IPTC`, `XMP`, `MakerNotes`, `ICC_Profile`, `Photoshop`, or `Composite` fails the file.
   
   Face regions deserve the specific mention: they hide in `XMP-mwg-rs` (Metadata Working Group region structures) and `MakerNotes`, and a naive "strip EXIF" pass leaves them behind. The group-level allowlist catches them because it rejects the entire `XMP` and `MakerNotes` namespaces rather than enumerating tags to remove. A failed verification on **any** derivative means the file is **not** written — no variant of it — and it is reported as failed. Requirement 4.3.
5. **Videos, via ffmpeg.**

```
ffmpeg -i <src> -map_metadata -1 -map_chapters -1 <mapping and audio flags> \
  -c:v libx264 -profile:v high -level 4.0 -preset slow -pix_fmt yuv420p \
  -vf "scale='min(1920,iw)':-2" -b:v <target> -maxrate <1.5x> -bufsize <3x> \
  -movflags +faststart -f mp4 <out>
```

   - `-map_metadata -1 -map_chapters -1` drops container metadata including creation time and location atoms. Verified afterwards with `ffprobe -show_format -show_streams`: the format and stream tag maps must be empty apart from `encoder`, `major_brand`, `minor_version`, `compatible_brands`, and `handler_name`.
   - `-movflags +faststart` moves the moov atom to the front. Without it, range-based seeking is useless — and case 4 of the Range handler depends on it too.
   - Target bitrate is computed from duration to land at ~90% of `MAX_VIDEO_BYTES` (18 MB), then verified against the actual output; over-size triggers one retry at 80% of the previous bitrate. Requirement 4.8.
   - **Stream mapping and audio, per file — three branches, each complete.** An earlier draft specified `-map 0:v:0` for every branch alongside a default of `-c:a aac -b:a 128k`, which cannot work: with only the video stream mapped, ffmpeg has no audio stream to encode and the codec flags are silently ignored. The output shipped mute regardless of intent. Corrected:

     | Option | Mapping | Codec | Result |
     | --- | --- | --- | --- |
     | *(default)* | `-map 0:v:0 -map 0:a:0?` | `-c:a aac -b:a 128k` | Source audio kept |
     | `--mute <file>` | `-map 0:v:0` | `-an` | No audio stream at all. Requirement 3.5 |
     | `--audio <file>=<track.m4a>` | `-i track.m4a -map 0:v:0 -map 1:a:0` | `-c:a aac -b:a 160k -shortest` | Substitute track. Requirement 3.5 |

     The trailing `?` on `-map 0:a:0?` makes the mapping optional, so a source with no audio track produces a video-only output instead of failing the encode — which is the common case for phone clips shot with the mic disabled, and not something that should abort a file.

     `MediaEntry.hasAudio` is set from `ffprobe` on the **output**, not from which flag was passed. The flag is intent; the probe is fact.
   - `poster`: `ffmpeg -ss <10% of duration> -frames:v 1` piped through the same sharp photo pipeline, so the poster is metadata-verified on exactly the same path as a photograph.
   - `head`: after the encode passes verification, read the first 262,144 bytes of the output and write them as the `head` variant. Skipped entirely when the output is ≤256 KB, since the head would be the whole file. Two checks before recording it: `ffprobe` must confirm the moov atom precedes mdat (`+faststart` did its job), and the moov atom's declared size must end inside the window. `+faststart` guarantees ordering, not that the moov fits in 256 KB — for an 18 MB, sub-three-minute, single-track H.264 file the sample tables run to tens of KB, but that is a property of this encode rather than a law, so it is verified per file. If the moov overruns the window, the `head` variant is not recorded and the Range handler falls back to case 3 for that video. Correct, just slower.
6. **Media_ID.** `base64url(crypto.randomBytes(16))` → 22 characters, 128 bits. Requirement 2.9. Nothing derived from the filename, timestamp, or ordinal, and collisions are checked against the in-progress index for completeness even though the probability is negligible.
7. **Write bytes**, one key per stored variant: `arch/{archiveId}/media/{mediaId}/{full|grid|poster|head}`, with `contentType` set. Photos write `full` and `grid`; videos write `full`, `poster`, and usually `head`. Requirement 4.4. Immediately read back each key's length and compare against what was written; mismatch fails the file. The media store is eventually consistent, so the readback retries with backoff for up to 10s before failing. The `head` readback additionally asserts byte equality with the first 262,144 bytes of `full`, because a `head` that is not a true prefix would hand a player corrupt data at a byte offset it trusts.
8. **Reference_Label.** Assigned after all files are processed, ordered by source `mtime` ascending then filename, as `QLK ` + the 1-based ordinal zero-padded to three digits, starting at `QLK 001`. Requirement 4.7. Ordinal → label is a pure function, which is what makes it testable.
9. **Index.** Written last, in one `set`. Until it lands, orphan bytes exist but no route can reach them (existence check step 4 consults the index). Requirement 4.6, with `hidden` defaulted false — expressed as a `vis/{mediaId}` document per item with `hidden: false, deleted: false, reason: 'INGEST'`, written in the same pass.
10. **Seed the code.** If `secret/attendee-code` is absent, generate a 10-character code, persist salt + hash at `codeVersion: 1`, and print the plaintext to stdout once with a warning that it will not be shown again. Keeps the plaintext out of Netlify env vars entirely.
11. **Report.** Per-file lines (`OK`, `SKIP raw`, `FAIL <reason>`) and a summary of counts. A failure on one file never aborts the run. Requirement 4.9. Exit code is non-zero if any file failed, so a mistake is not silently shipped.

`--dry-run` does everything except write to Blobs, including the inline-payload budget check from step 3. That is how the Photographer checks sizes, stripping, and the 5 MB grid ceiling before touching production.

---

## Visual System

A private archive of an underground queer rave should not look like a client proofing gallery. The reference points are the physical artifacts of that night: a xeroxed flyer, a strobe-lit room, a video camera in the dark, overexposed film. The techniques below are cheap CSS, not a WebGL budget — they have to render on a phone in a rideshare at 3 a.m.

### Type

Two families, both self-hosted through `next/font/local` with committed woff2 subsets, so `font-src 'self'` holds and there is not one third-party request anywhere in the app. Requirement 11.2.

| Role | Family | Usage |
| --- | --- | --- |
| Display | **Anton** (400) | Wordmark, event name, section headers, the ended state. All caps, `tracking-[-0.035em]`, `leading-[0.82]` |
| Everything else | **IBM Plex Mono** (400, 600) | Body, labels, countdown, controls |

Mono for body copy is the identity decision. It reads as a technical record rather than a lifestyle gallery, it makes `QLK 017` and the countdown digits feel native instead of pasted on, and it drops a whole font file. Set at `15px/1.65` with `-0.005em` tracking, which measures comfortably at 375 px.

```
display:  clamp(2.75rem, 12vw, 9rem)   Anton, uppercase, -0.035em, 0.82
h2:       clamp(1.25rem, 4vw, 2rem)    Anton, uppercase, -0.02em
body:     0.9375rem / 1.65             Plex Mono 400
label:    0.6875rem, uppercase, 0.28em tracking, Plex Mono 600
countdown: clamp(1.5rem, 6vw, 3rem)    Plex Mono 600, tabular-nums
```

### Color tokens

```ts
// tailwind.config.ts → theme.extend.colors
colors: {
  void:  '#080809',  // page base — the room with the lights off
  tar:   '#111114',  // raised surface
  ash:   '#1C1C21',  // hairlines, tile borders
  flash: '#F5F3EE',  // display white, warm — overexposed frame, not #fff
  bone:  '#E8E5DE',  // body text
  smoke: '#A8A29A',  // muted text, labels
  uv:    '#7A3CFF',  // blacklight — accent only
  acid:  '#39FF6A',  // night vision — focus rings, ended state
  siren: '#FF2D2D',  // destructive actions, countdown urgency
  ice:   '#2DE1FF',  // chromatic fringe only
}
```

Measured WCAG contrast against both surfaces, and the rule each token carries:

| Token | on `void` | on `tar` | Body text? |
| --- | --- | --- | --- |
| `flash` #F5F3EE | 18.05:1 | 17.00:1 | yes |
| `bone` #E8E5DE | 15.91:1 | 14.98:1 | yes — default body color |
| `smoke` #A8A29A | 7.91:1 | 7.45:1 | yes — labels, secondary copy |
| `acid` #39FF6A | 14.95:1 | 14.08:1 | yes |
| `siren` #FF2D2D | 5.40:1 | 5.08:1 | yes |
| `ice` #2DE1FF | 12.70:1 | 11.96:1 | decorative only, by convention |
| `uv` #7A3CFF | **3.73:1** | **3.52:1** | **never — fails 4.5:1** |

`uv` is the signature color and it fails as text on every surface we have. It is restricted to fills, glows, hairlines, and light-leak gradients, and the Tailwind config exposes it as `bg-uv` / `border-uv` / `shadow-uv` with no `text-uv` utility generated. Enforcing the accessibility rule in the token layer beats hoping a reviewer catches it. Requirement 9.6.

### Techniques

Every effect is a `pointer-events: none` fixed overlay or a static filter. None of them intercept input, and none are required to read anything.

**Grain** — the base texture, always on. An inline SVG `feTurbulence` data URI (`baseFrequency="0.85" numOctaves="4"`) tiled at 220 px, `position: fixed; inset: 0; z-index: 50; opacity: .16; mix-blend-mode: overlay`. Animated by stepping `background-position` through 8 discrete positions with `animation: grain 800ms steps(8) infinite` — no interpolation, so it flickers like film rather than sliding. A data URI keeps it inside `img-src 'self' data:` with zero extra requests. It lives in `globals.css`, served as an external stylesheet, and never in an inline `<style>` or a `style=` attribute — so an unauthenticated HTML body contains zero `data:` URIs and Requirement 14.24 stays a structural check rather than an allowlist.

**Scanlines** — the CRT layer, on the featured video frame and the ended state. `repeating-linear-gradient(to bottom, transparent 0 2px, rgba(0,0,0,.22) 2px 3px)` at `z-index: 40`, plus a 6s 1px vertical drift.

**Light leak** — two `radial-gradient` blobs, `uv` at 10% and `siren` at 7%, `filter: blur(90px)`, anchored off the top-left and bottom-right, drifting on a 60s `transform: translate3d` loop. This is what keeps the page from reading as flat black.

**Vignette** — `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,.7) 100%)`, fixed, `z-index: 45`. Pulls the eye to the photographs.

**Overexposure flash** — one full-viewport `flash` white-out for 120 ms, then a cut to black, played exactly once on a successful code entry as the transition into the archive.

> **This is a photosensitivity constraint, not a style detail.** WCAG 2.3.1 sets a three-flash threshold. The implementation is hard-capped at a single flash, is never repeated, never loops, is not triggered on the failure path (a wrong code should not produce a reward stimulus), and is fully removed under `prefers-reduced-motion: reduce`, where the transition is an instant state change. No other element in the app flashes, blinks, or strobes.

**Chromatic fringe** — display type gets `text-shadow: -1px 0 0 rgba(45,225,255,.55), 1px 0 0 rgba(255,45,45,.45)`. Static, so it is not motion and stays on under reduced motion. Reads as a mistracked video capture.

**Xerox** — `filter: grayscale(1) contrast(1.75) brightness(1.05)` on decorative chrome marks only. **Never applied to a Media_Item.** The photographs are the Photographer's finished edit and render untouched; the interface around them is what looks photocopied.

**Taped labels** — `QLK NNN` chips get `rotate(-0.4deg)`, a 1px `ash` hairline, a 2px hard offset shadow, and alternating rotation direction by index parity. Small and physical, like tape on a contact sheet.

### Layout

Full-bleed, dense, no centered max-width container. Gutters are 2 px on mobile and 3 px at desktop, so the grid reads as a contact sheet rather than a portfolio.

```
┌─ sticky hairline bar, 32px: FLASHBACK · countdown ─┐
│  QLICK QRAVE                    (display, bleeds)  │
│  featured video   max-height: 38vh                 │
│  privacy notice   persistent, not dismissible      │
│  ── photo grid, full bleed ──────────────────────  │
│  1 col @375  ·  2 @640  ·  3 @1024  ·  4 @1536     │
│  footer: Built with PLUR by film.fyi               │
└────────────────────────────────────────────────────┘
```

The featured video is capped at `38vh` so that at least one full grid row is visible at 375 × 667. That is the concrete, checkable reading of "photographs get the largest share of the viewport." Requirement 9.1, 9.2.

Tiles use `aspect-ratio` computed from the stored dimensions, so there is zero layout shift and no JS measurement. Their `<img src>` is the inline `data:` URI of the `grid` variant, with `decoding="async"` and intrinsic `width`/`height` from the index; `loading="lazy"` is omitted because it does nothing for bytes already present in the document. Hover changes only the hairline color to `acid` — no scale transform, which keeps 40 tiles smooth and makes the reduced-motion path identical to the default.

**Countdown.** Mono, `tabular-nums`, digits in `flash` with units in `smoke` at label scale, sitting on a `siren` hairline whose width is the fraction of the window remaining — a strip of tape shortening across the top of the page. Under 24 hours the digits turn `siren` and pick up a 1.2s opacity pulse (static under reduced motion). Rendered from a server-supplied ISO string and ticked client-side every 30 s for display only; the server value is the only one that authorizes anything. Requirement 8.1, 8.9.

**Ended state.** Full black, scanlines, `acid` mono `THIS FLASHBACK HAS ENDED.` centered with a `0 0 8px` glow. No grid, no tiles, no media references in the markup. Night vision after the room emptied. Requirement 8.4, 8.5.

**Privacy notice.** Persistent block between the video and the grid, `bone` on `tar` with a `uv` left rule. Asks viewers not to identify, tag, download, screenshot, record, or redistribute anyone depicted, and links to the removal control. Not a dismissible toast — it stays for the life of the page. Requirement 9.4.

**Deterrents.** Tiles set `onDragStart` and `onContextMenu` to `preventDefault`, plus `draggable={false}` and `user-select: none`. The copy calls these deterrents and makes no claim about preventing screenshots, because a website cannot. Requirement 10.1–10.4.

### Accessibility

- Focus is `outline: 2px solid acid; outline-offset: 2px` globally. `outline: none` appears nowhere.
- Alt text is `Photograph QLK 017 from Qlick QRave` — deliberately generic. We will not auto-describe the people in these images: we cannot do it accurately, and attempting it would manufacture exactly the identifying description the project exists to avoid. The label carries the identity of the *item*, which is what a screen reader user needs to operate the removal control. Requirement 9.6.
- One reduced-motion block: `animation: none !important; transition: none !important` on the effect utilities, grain frozen to a single frame, no flash, no pulse. Every control, the video, and the removal flow behave identically. Requirement 9.5.
- Full keyboard operation: native `<input>`, `<button>`, `<video controls>`, and `<a>` throughout. The removal modal traps focus, returns it to the invoking control on close, closes on Escape, and is labelled by its heading. Requirement 9.7.
- Footer is exactly `Built with PLUR by film.fyi` with the hyperlink on `film.fyi` alone. Requirement 9.8.
- Zero hire-me content, contact forms, newsletter fields, portfolio links, or lead capture, anywhere. Requirement 9.9.

---

## Security Headers and CSP

Headers are set in two places, deliberately overlapping.

**`middleware.ts`** — per-request, because the CSP nonce changes every request:

```
Content-Security-Policy:
  default-src 'self';
  base-uri 'none';
  object-src 'none';
  script-src 'self' 'nonce-{NONCE}' 'strict-dynamic';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  media-src 'self';
  font-src 'self';
  connect-src 'self';
  form-action 'self';
  frame-src 'none';
  frame-ancestors 'none';
  worker-src 'self';
  manifest-src 'self';
  upgrade-insecure-requests
```

**`next.config.ts` `headers()`** for `/(.*)` — the static set, so it applies to every Next route including API responses:

```
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Robots-Tag: noindex, nofollow
X-Frame-Options: DENY
```

**`netlify.toml` `[[headers]]`** for `/*` — the same static set again, covering assets served straight off the CDN that never touch the Next handler. Duplicated headers are harmless; a missing one on a static path is not.

Requirement 12.1–12.5, 11.3. HTTPS is Netlify's default with HTTP redirected, satisfying 12.7 at the platform level.

`Cache-Control` is deliberately **not** in any of those three sets, because it is the one header whose correct value differs by route class:

| Response | `Cache-Control` | Set where | Requirement |
| --- | --- | --- | --- |
| Media_API bytes (`full`, `grid`, `poster`) | `private, max-age=60` | The route handler, next to `Vary: Cookie` | 2.8, 12.6, 12.8 |
| Archive_View, Admin_View HTML | `private, no-store` | `next.config.ts headers()` scoped to `/archive` and `/admin`, and re-set on the middleware response | 12.9 |
| Access_Screen HTML | `private, no-store` | Same | — carries no media, but also carries archive state |
| Static assets (fonts, CSS, JS chunks) | Next's own hashed-asset defaults | Untouched | — |

Blanket-applying `no-store` in the `/*` set would have been simpler and would have killed caching on the hashed font and chunk files, which are public by construction and contain nothing protected. Scoping it is worth the extra two lines. Requirement 14.23 and 14.25 check both values against the deployed site, in opposite directions — media must say `max-age=60`, HTML must say `no-store` — which is the kind of pair that a single global header silently gets half right.

### What Next.js needs, and the honest residual

`script-src` uses a nonce plus `'strict-dynamic'`. Next App Router injects an inline bootstrap script and inline Flight-data scripts; without a nonce they need `'unsafe-inline'`, which would defeat the point. With `'strict-dynamic'`, CSP3 browsers ignore the `'self'` source expression and trust only nonced scripts plus what they load — which is the strongest posture available here. `'self'` stays in the list as the CSP2 fallback.

`style-src` keeps `'unsafe-inline'`. React sets inline `style` attributes, and `next/font/local` emits an inline `<style>` block. Nonce-ing every inline style in App Router is not reliably supported today, and the alternative — dropping self-hosted fonts or hand-rolling the font CSS — costs more than it buys. The residual risk is CSS injection, which given `default-src 'self'`, `img-src 'self' data:`, and `connect-src 'self'` has no exfiltration channel out of the origin. Recorded here rather than papered over.

`img-src` allows `data:` — for the grain SVG and, on authenticated Archive_View and Admin_View responses, for the inline grid thumbnails. **No CSP change was needed to add inlining**, which is worth stating because it is easy to assume otherwise: `data:` was already permitted for the grain overlay, so the base64 `<img src>` values fall inside the existing policy. `blob:` remains deliberately absent — nothing in the app constructs an object URL, and forbidding it removes an obvious route for a client-side copy of a Media_Item.

`frame-ancestors 'none'` plus `X-Frame-Options: DENY` blocks embedding, which is what keeps a Media_API response from being framed inside someone else's page. Requirement 12.1.

### Indexing

Three layers, none of which is a security control. Requirement 11.6.

- `X-Robots-Tag: noindex, nofollow` on every response (11.3)
- `<meta name="robots" content="noindex, nofollow">` via the App Router `metadata` export on every page (11.4)
- `app/robots.ts` returning `User-agent: * / Disallow: /` (11.5)

### Logging

Netlify function logs get event names, decision codes, and Media_IDs. They never get an IP, a user agent, a code plaintext, a token, or a removal note. Netlify's own platform access logs are outside our control and do record request metadata; that is a property of the host, not data FLASHBACK collects, and it is worth the Photographer knowing.

---

## Error Handling

One rule: **fail closed.** Every unexpected condition on a protected path resolves to fewer bytes, never more.

| Condition | Status | Body | Notes |
| --- | --- | --- | --- |
| No / invalid / expired session | 401 | `{"error":"UNAUTHORIZED"}` | Indistinguishable across all three causes |
| Attendee session on an admin route | 403 | `{"error":"FORBIDDEN"}` | No state change |
| Archive `DISABLED`, attendee | 403 | `{"error":"FORBIDDEN"}` | Organizer unaffected |
| Past expiration, attendee | 403 | `{"error":"FORBIDDEN"}` | Organizer unaffected |
| Unknown Media_ID | 404 | `{"error":"NOT_FOUND"}` | Same as hidden and deleted |
| Hidden or deleted Media_Item | 404 | `{"error":"NOT_FOUND"}` | Attendee only; organizer sees hidden |
| Bad confirmation string | 400 | `{"error":"CONFIRM_REQUIRED"}` | Zero deletions |
| Note over 1000 chars | 400 | `{"error":"NOTE_TOO_LONG"}` | Nothing written |
| Rate limit exceeded | 429 | `{"error":"SLOW_DOWN"}` | `Retry-After: 60` |
| Unsatisfiable range | 416 | empty | `Content-Range: bytes */<size>` |
| `config` or `vis` unreadable / unparseable | 503 | `{"error":"UNAVAILABLE"}` | Treated as denied, never as allowed |
| Blob byte read fails or length mismatches | 503 | `{"error":"UNAVAILABLE"}` | Never a truncated body |
| No attendee code record and no seed env | — | Admin diagnostic | Archive forced `DISABLED` |

No error response ever includes a stack trace, a blob key, an env var value, or a hint about the expected code. Attendee-facing failures render as an in-identity `acid`-on-black terminal message with a route back to `/`.

---

## Testing Strategy

Two complementary layers. Property tests cover universal behavior; example tests cover specific renders, copy, and platform wiring.

### Harness

- **Vitest** for everything, `--run` in CI. No watch mode.
- **fast-check** for property tests, minimum **100 runs** per property.
- **@testing-library/react** + jsdom for render properties.
- **`FakeBlobStore`** — an in-memory implementation of the narrow `Store` interface the app actually uses (`get`, `getWithMetadata`, `set`, `delete`, `list`). All server code obtains stores through `lib/blobs/meta.ts` / `lib/blobs/media.ts`, so tests inject the fake at that seam. The fake has an `eventual` mode that delays visibility of writes, which is how Property 2 gets tested: run the gate against a store in eventual mode and assert it still observes fresh values, i.e. that the strong-consistency store is the one being used.
- **`scripts/verify-deployed.ts`** — `npm run verify -- --url <site> --code <code> --secret <secret>`. Plain `fetch`, no browser, non-zero exit on any failure. This is Requirement 14 as executable code. No headless browser dependency for a same-day ship.

Local `netlify dev` cannot see production blobs, so the deployed verification script is the only evidence that counts for Requirement 14.1.

### Property test tagging

Every property test names its design property:

```ts
// Feature: flashback, Property 1: For any combination of session state,
// archive state, expiration, and item visibility, the gate returns the status
// dictated by the ordered chain and performs zero media byte reads on denial.
it('Property 1: gate decision table', () => {
  fc.assert(fc.property(arbGateScenario(), (s) => { /* ... */ }), { numRuns: 200 });
});
```

### Priority for ship day

Not all 34 properties are equally load-bearing. **Tier 1** must pass before the archive is handed to the Organizer: **1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 25, 31.** Those are the ones where a failure means exposed media, escalated privilege, or leaked identity. Tier 2 is everything else — real bugs, but not the kind that hurt someone depicted in a photograph.

### Generators

- `arbGateScenario` — the cross product of session kind (none, attendee, organizer, expired, tampered, stale `cv`) × archive state × expiration (past, future) × item state (missing, visible, hidden, deleted) × variant. The decision table in one generator.
- `arbCode` — strings from the 31-character alphabet, length 8–12, plus whitespace and case perturbations.
- `arbMediaIndex` — 0–60 entries with realistic dimensions and adversarial original filenames (`IMG_2847 Sabrina backstage 2024-11-16 GPS.jpg`, unicode, path separators) used to prove the renderer leaks nothing.
- `arbRange` — valid, suffix, open-ended, inverted, past-end, zero-length, and non-`bytes` unit forms against object sizes from 1 byte to 18 MB, weighted to straddle the 256 KB head boundary in both directions (`bytes=0-1`, fully inside, fully outside, and starting inside and running past) so that case 4 and its clamp are exercised rather than assumed.
- `arbRemovalPayload` — valid bodies plus arbitrary extra keys, prototype-pollution shapes, oversized notes, and header sets carrying IPs and user agents.
- `arbImage` — small synthetic images with injected EXIF, GPS, IPTC, XMP-mwg-rs face regions, and MakerNotes. Small dimensions keep 100 sharp encodes fast enough to run in CI.

Video encoding is **not** property-tested. One ffmpeg invocation costs seconds; 100 iterations is minutes. Videos get example tests over a small fixture set, which is the right tool for a deterministic external binary.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: The gate decides every protected entry point

*For any* combination of session state (absent, attendee, organizer, signature-invalid, expired, stale code version), archive state, expiration timestamp, and item state (unknown, visible, hidden, deleted), a request to the Media_API, the Archive_View, or the Removal_API returns the status dictated by the ordered chain session → archive state → expiration → existence → visibility, and performs zero media byte reads whenever any check fails.

**Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 5.8, 6.4, 8.3, 11.6**

### Property 2: Safety state is never read stale

*For any* authorization evaluation, every read of the archive configuration and of a Media_Item's visibility observes the most recently written value, even when the underlying store is configured to delay propagation.

**Validates: Requirements 2.11**

### Property 3: Code verification is normalization-invariant and rejects everything else

*For any* active Attendee_Code and *any* perturbation of it by letter case, leading whitespace, trailing whitespace, or internal whitespace, the Access_API accepts the submission; and *for any* string whose normalized form differs from the active code, the Access_API responds 401, issues no cookie, and returns a body identical for every rejected input.

**Validates: Requirements 1.3, 1.5, 1.6**

### Property 4: Session tokens are well-formed, and anything else is no session

*For any* issued session, the cookie carries HttpOnly, Secure, SameSite=Strict, Path=/, and a 12-hour lifetime, and a successful attendee issuance redirects to the Archive_View; and *for any* cookie value not produced by the current signing key — tampered payload, tampered signature, truncated, wrong prefix, role swapped between cookie slots, or past its expiry — the request is treated as carrying no session.

**Validates: Requirements 1.4, 1.11, 7.4, 7.8, 7.9**

### Property 5: Rotation replaces the code and invalidates prior attendee sessions

*For any* archive state and *any* rotation, the newly generated code is accepted, the previous code is rejected, the new plaintext is returned exactly once and is absent from every subsequent read, and *every* attendee session issued before the rotation is thereafter treated as carrying no session while organizer sessions remain valid.

**Validates: Requirements 6.6, 6.7**

### Property 6: Organizer privileges come only from an organizer session

*For any* Admin_API route and *any* request carrying no session or only an attendee session, the response is 401 or 403 respectively and the persisted state is byte-identical before and after the request.

**Validates: Requirements 7.1, 7.2, 7.3, 7.5, 7.6**

### Property 7: Cross-origin state change is refused

*For any* state-changing Admin_API request carrying a valid organizer session and an `Origin` header that differs from the deployed site origin, or carrying no `Origin` header, the response is 403 and the persisted state is byte-identical before and after the request.

**Validates: Requirements 7.7**

### Property 8: Range responses return exactly the bytes they describe

*For any* stored object of length N and *any* `Range` header, the response body is a contiguous subrange of the requested range, the `Content-Range` header describes precisely the bytes present in the body, the status is 206 for a satisfiable partial request and 416 for a start beyond N, a request with no valid range header yields the full object with status 200, and every video response carries `Accept-Ranges: bytes`.

**Validates: Requirements 3.1, 3.2**

### Property 9: Every response carries the full security header set

*For any* route in the application's route table and *any* session state, the response carries a Content-Security-Policy restricting `default-src` to the site origin and setting `frame-ancestors` to `'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a `Permissions-Policy` denying camera, microphone, and geolocation, `Strict-Transport-Security` with `max-age` at least 31536000, and `X-Robots-Tag: noindex, nofollow`; and every rendered page carries a `robots` meta tag with `noindex, nofollow`.

**Validates: Requirements 11.3, 11.4, 12.1, 12.2, 12.3, 12.4, 12.5**

### Property 10: Protected responses are never cacheable and always vary on cookie

*For any* Media_API response and *any* authenticated HTML response, the response carries `Cache-Control: private, no-store` and `Vary: Cookie`, and carries no `ETag`, `Last-Modified`, or `Age` header.

**Validates: Requirements 2.8, 12.6**

### Property 11: Media identifiers are opaque and unique

*For any* batch of Media_IDs generated by the Ingest_Script, all identifiers are distinct, each encodes at least 128 bits of randomness, and no identifier contains any substring of its source filename, its file extension, its modification date in any common format, or its ordinal position.

**Validates: Requirements 2.9**

### Property 12: Rendered output leaks no source identity

*For any* media index containing arbitrary original filenames and paths, the rendered Archive_View markup and every JSON payload it embeds reference each Media_Item exclusively through a Media_API URL containing its Media_ID, contain no original filename, path, or extension substring, and contain no value derived from source file metadata; and the unauthenticated Access_Screen response contains zero references to any Media_Item.

**Validates: Requirements 1.2, 2.10**

### Property 13: Every visible tile is complete and every hidden one is absent

*For any* media index and visibility state, the rendered Archive_View emits exactly one tile per visible Media_Item — each carrying its Reference_Label, non-empty alternative text, one removal control, and suppressed drag and context-menu defaults — and emits zero tiles and zero media references for Media_Items that are hidden or deleted.

**Validates: Requirements 5.1, 9.3, 9.6, 10.2, 10.3**

### Property 14: Removal records contain exactly the allowlisted fields

*For any* removal request payload containing arbitrary additional fields and *any* set of request headers including client IP and user agent values, the stored removal record's key set equals exactly {record identifier, Media_ID, submission timestamp, optional note, review status}, the record's status is `PENDING`, the Media_ID and note read back identical to the accepted submission, and no stored value equals or contains any request-derived identifier.

**Validates: Requirements 5.2, 5.3, 5.5, 5.6, 11.1, 15.2**

### Property 15: A removal request hides before it responds

*For any* accepted removal request, the referenced Media_Item's hidden flag is already true at the moment the response is emitted, and a Media_API request for that Media_Item issued immediately after the response returns 404 with zero media bytes.

**Validates: Requirements 5.4, 5.7**

### Property 16: Review does not restore visibility

*For any* removal record and *any* sequence of review status transitions, the referenced Media_Item's hidden flag remains true.

**Validates: Requirements 6.14**

### Property 17: State toggles are round trips

*For any* archive state, disabling and then enabling the archive restores attendee access to exactly the set of Media_Items reachable beforehand; and *for any* Media_Item, hiding and then restoring it returns its visibility document to its prior value, while during the hidden interval an attendee request returns 404 and an organizer request returns the bytes.

**Validates: Requirements 6.3, 6.5, 6.9, 6.10, 6.15**

### Property 18: Deletion is confirmed, scoped, and complete

*For any* non-empty subset of Media_Items, a delete request whose confirmation string does not exactly match the server-computed expected value removes zero bytes and changes zero visibility documents; and a correctly confirmed delete removes every variant of exactly the targeted items, marks exactly those items deleted, and leaves every other item's bytes and visibility unchanged.

**Validates: Requirements 6.11, 6.12, 6.13**

### Property 19: Concurrent visibility mutations are confluent

*For any* set of visibility mutations targeting distinct Media_Items and *any* interleaving of their execution, the final visibility state reflects every mutation, and the resulting state is independent of the order in which they were applied.

**Validates: Requirements 5.4, 6.9, 6.11**

### Property 20: Expiration changes persist

*For any* submitted expiration timestamp, including timestamps in the past and submissions made while the archive is already expired, the Admin_API persists the value and the next render of the Archive_View and Admin_View displays the persisted value.

**Validates: Requirements 6.8, 8.7**

### Property 21: Expiry stops attendees and destroys nothing

*For any* archive whose expiration timestamp has passed, an attendee Media_API request returns 403, the Access_API returns 403 for every submitted value, attendee-facing HTML contains the text `THIS FLASHBACK HAS ENDED.` and zero Media_Item references, the Admin_View renders for a valid organizer session, and the set of media blob keys is identical to the set before expiry.

**Validates: Requirements 8.4, 8.5, 8.6, 8.8**

### Property 22: Authorization ignores client-supplied time

*For any* request and *any* client-supplied time value placed in a header, query parameter, cookie, or body field, the authorization decision is identical to the decision produced for the same request with that value absent.

**Validates: Requirements 8.9**

### Property 23: Derived display values equal computed values

*For any* archive configuration and media index, the Admin_View's displayed photograph count, video count, and pending removal count equal the counts computed from stored state; the Archive_View's displayed remaining time equals the correct decomposition of the interval to the expiration timestamp into days, hours, and minutes; and the Admin_View's distribution text contains the archive URL.

**Validates: Requirements 6.1, 8.1, 15.3**

### Property 24: Ingest preserves sources and accounts for every file

*For any* directory containing any mixture of supported photographs, supported videos, RAW files, unsupported files, and unreadable files, every source file's bytes are unchanged after the run, every supported file either produces exactly one index entry or is reported as failed with a reason, every RAW file is reported as skipped by name and produces no derivative, and the run processes all remaining files after any individual failure.

**Validates: Requirements 4.1, 4.5, 4.9**

### Property 25: Derivatives carry no embedded metadata

*For any* source photograph carrying arbitrary EXIF, IPTC, XMP, GPS, camera serial number, creator contact, or embedded face-region metadata, the derivative written to the Blob_Store contains no tag outside the fixed structural allowlist, and any derivative failing that check is not written.

**Validates: Requirements 4.3**

### Property 26: Derivatives fit within their size bounds

*For any* source photograph of any dimensions, the full derivative's longest edge is at most 2400 pixels and its encoded size is at most 1 MB; *for any* video derivative, the encoded size is at most 18 MB; and *for any* Media_API response, the emitted body length is at most the platform's streamed response ceiling.

**Validates: Requirements 4.2, 4.8, 13.3**

### Property 27: Index and blob store agree after ingest

*For any* completed ingest run, every index entry has, for each declared variant, a blob at the key derived from its Media_ID whose byte length equals the recorded byte length, every media blob key written by the run corresponds to a declared variant of an index entry, and every index entry has a visibility document with hidden and deleted both false.

**Validates: Requirements 4.4, 4.6**

### Property 28: Reference labels are a total ordered function of position

*For any* count of processed Media_Items up to 999, the assigned Reference_Labels are exactly the sequence `QLK 001` through `QLK NNN` with three-digit zero padding, each label is unique, and label order matches display order.

**Validates: Requirements 4.7**

### Property 29: Generated codes are transcribable

*For any* generated Attendee_Code, its length is between 8 and 12 characters inclusive and every character is drawn from an alphabet excluding `0`, `O`, `1`, `I`, and `L`.

**Validates: Requirements 1.7**

### Property 30: The rate limiter bounds a single client's window

*For any* sequence of countable events from one client address within any 60-second interval, the request following the scope's limit receives 429, and *for any* concurrent sequence from a different client address, that address's own responses are unaffected.

**Validates: Requirements 1.8, 1.9, 5.9**

### Property 31: Secrets never appear in output

*For any* route response body, *any* asset in the built client bundle, and *any* value written to the Blob_Store, the content contains neither the Organizer_Secret, nor the session signing key, nor the Attendee_Code plaintext, nor the Attendee_Code hash, nor its salt.

**Validates: Requirements 1.10, 13.6**

### Property 32: Seeding is idempotent and non-destructive

*For any* Blob_Store state, running the seed path twice produces the same result as running it once, and seeding never overwrites an existing archive configuration or attendee code record — in particular it never reverts a rotated code or an organizer-set expiration timestamp.

**Validates: Requirements 13.5**

### Property 33: Every subresource is same-origin

*For any* rendered page, every script, stylesheet, font, image, media, and connection target in the markup resolves to the site origin or to an inline `data:` URI, and no reference resolves to a third-party host.

**Validates: Requirements 11.2**

### Property 34: Body text meets contrast on every surface

*For any* pairing of a body-text color token with a surface color token permitted by the design system, the computed contrast ratio is at least 4.5:1, and no token marked as non-text-safe is reachable through a text color utility.

**Validates: Requirements 9.6**

---

## Appendix: Acceptance Criteria Test Classification

Criteria not listed as PROPERTY are covered by example tests, deployed integration checks, or static/smoke checks. Recorded so the Tasks phase does not have to re-derive it, and so nobody reaches for property-based testing where it does not belong.

| Criteria | Classification | Approach |
| --- | --- | --- |
| 1.1 | EXAMPLE | Render assertion on `/` |
| 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11 | PROPERTY | Properties 3, 4, 12, 29, 30, 31 |
| 2.1 | SMOKE | Static check: no media file types under `public/` |
| 2.2–2.11 | PROPERTY | Properties 1, 2, 10, 11, 12 |
| 3.1, 3.2 | PROPERTY | Property 8 |
| 3.3, 3.4, 3.6 | EXAMPLE | Attribute assertions on the rendered `<video>` |
| 3.5 | EXAMPLE | ffmpeg fixture runs; one invocation per option, too costly to randomize |
| 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9 | PROPERTY | Properties 24, 25, 26, 27, 28 |
| 4.8 | EXAMPLE + PROPERTY | Size bound in Property 26; encoding verified on fixtures |
| 4.10 | SMOKE | `.gitignore` coverage and a startup env check |
| 5.1–5.6, 5.9 | PROPERTY | Properties 13, 14, 15, 30 |
| 5.7 | EXAMPLE | Confirmation copy after a successful submission |
| 5.8 | PROPERTY | Property 1 |
| 6.1, 6.3–6.14 | PROPERTY | Properties 5, 16, 17, 18, 20, 23 |
| 6.2, 6.15 | EXAMPLE / PROPERTY | Control inventory is an example; organizer preview is Property 17 |
| 7.1–7.9 | PROPERTY | Properties 4, 6, 7 |
| 8.1, 8.3–8.9 | PROPERTY | Properties 1, 20, 21, 22, 23 |
| 8.2 | EXAMPLE | Default expiration is 12 days after creation |
| 9.1, 9.2 | EXAMPLE | Featured video capped at 38vh; single column renders at 375 px |
| 9.3, 9.6 | PROPERTY | Properties 13, 34 |
| 9.4, 9.5, 9.7, 9.8, 9.9 | EXAMPLE | Privacy notice copy, reduced-motion block, keyboard traversal, footer text, absence of promotional content |
| 10.1, 10.4 | EXAMPLE | No download control; deterrent wording |
| 10.2, 10.3 | PROPERTY | Property 13 |
| 11.1, 11.2, 11.3, 11.4 | PROPERTY | Properties 9, 14, 33 |
| 11.5 | EXAMPLE | `robots.txt` content |
| 11.6 | PROPERTY | Property 1 |
| 12.1–12.6 | PROPERTY | Properties 9, 10 |
| 12.7 | SMOKE | Platform-enforced; confirmed by the deployed check |
| 13.1, 13.2, 13.4 | SMOKE | Dependency allowlist; static ban on `getDeployStore` and `next/image` in the archive tree |
| 13.3 | PROPERTY | Property 26 |
| 13.5 | PROPERTY | Property 32 |
| 13.6 | PROPERTY | Property 31 |
| 13.7 | — | Process requirement, not testable |
| 14.1–14.16 | INTEGRATION | `npm run verify` against the deployed URL. Not property-tested: these confirm one deployed configuration, behavior does not vary with input, and repetition finds nothing a single run does not. 14.10's 5-second bound is a timed assertion against the live site. |
| 15.1 | — | Handoff artifact, not testable |
| 15.2 | PROPERTY | Property 14 |
| 15.3 | PROPERTY | Property 23 |
| 15.4 | SMOKE | README contains the ingest command, env var names, and the disable control location |

---

## Environment Variables

| Name | Scope | Required | Purpose |
| --- | --- | --- | --- |
| `FLASHBACK_SESSION_KEY` | site | yes | 32 random bytes, base64. HMAC key for session cookies and IP hashing |
| `FLASHBACK_ORGANIZER_SECRET` | site | yes | Organizer secret. Env only, never persisted (Requirement 13.6) |
| `FLASHBACK_ATTENDEE_CODE_SEED` | site | no | First-boot code seed. Normally unset because ingest seeds the code |
| `FLASHBACK_EXPIRES_AT` | site | no | ISO 8601 seed for expiration; defaults to now + 12 days |
| `FLASHBACK_ARCHIVE_ID` | site | no | Defaults to `qlick-qrave`. Key namespace and store partition |
| `FLASHBACK_EVENT_NAME` | site | no | Defaults to `QLICK QRAVE` |
| `FLASHBACK_SITE_ORIGIN` | site | no | Origin-check target; falls back to Netlify's `URL` |
| `NETLIFY_SITE_ID` | ingest only | yes | Blob store target for the Photographer's laptop |
| `NETLIFY_API_TOKEN` | ingest only | yes | Blob store credential. Lives in `.env.ingest.local`, gitignored |

The app refuses to start if `FLASHBACK_SESSION_KEY` or `FLASHBACK_ORGANIZER_SECRET` is missing. An unsigned session and an absent organizer secret are both failure modes that must not degrade quietly into an open archive.

---

## Out of Scope for v1

Attendee accounts. Admin upload UI. Scheduled auto-purge. The subject-consent QR system (only the `MediaEntry.subjects` field and the gate's predicate list exist as seams). Native apps. Analytics of any kind. Public media URLs. Multi-event support — though `FLASHBACK_ARCHIVE_ID` namespaces every blob key and appears in no hardcoded string, so a second event is a new deployment variable rather than a data migration.
