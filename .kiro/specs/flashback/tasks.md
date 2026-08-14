# Implementation Plan: FLASHBACK

## Overview

TypeScript throughout. Next.js 15 App Router on Netlify, `@netlify/blobs` for all state, Vitest + fast-check for tests, `tsx` for the offline ingest script.

The ordering is driven by one thing: the security-critical path is built and deployable first. Tasks 1–8 stand up the scaffold, the blob layer, sessions, the single authorization gate, the Media_API, the Access_API, and the header set — then deploy and run a partial deployed verification. Nothing cosmetic happens before that gate is provably closed against a live URL.

Removal, admin controls, the attendee surfaces, the visual system, and the ingest pipeline follow. Tasks 16–19 complete the full 16-check deployed verification, run the real ingest against production blobs, and execute the security matrix against the live site. A successful local build is explicitly not the finish line (Requirement 14.1).

Test tasks marked `*` are optional. Every **Tier 1 property test (1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 25, 31) is unmarked and required** — a failure in any of those means exposed media, escalated privilege, or leaked identity, so they ship with v1. Tier 2 properties and supplementary example tests carry `*`.

## Tasks

- [ ] 1. Project scaffold and test harness

  - [ ] 1.1 Initialize the Next.js 15 App Router project with the pinned dependency set
    - `create-next-app` with App Router, TypeScript, no `src/` dir; `tsconfig.json` with `strict: true`
    - `package.json` with exact pins: `next@15.x`, `typescript@5.x`, `tailwindcss@3.4.x`, `@netlify/blobs@8.x`, `@netlify/plugin-nextjs@5`, `sharp`, `exiftool-vendored`, `ffmpeg-static`, `tsx`, `vitest`, `fast-check`, `@testing-library/react`, `jsdom`
    - Scripts: `dev`, `build`, `test` (`vitest --run`), `ingest` (`tsx scripts/ingest/index.ts`), `verify` (`tsx scripts/verify-deployed.ts`)
    - `next.config.ts` with `images: { unoptimized: true }` — the Netlify Image CDN would cache transformed media outside the gate
    - `.gitignore` covering `.env*.local` and `.env.ingest.local`
    - Minimal `app/layout.tsx` and `app/globals.css` with the Tailwind directives
    - _Requirements: 13.1, 13.2, 4.10_

  - [ ] 1.2 Configure Tailwind 3.4 with the design color tokens
    - `tailwind.config.ts` extending `theme.colors` with `void`, `tar`, `ash`, `flash`, `bone`, `smoke`, `uv`, `acid`, `siren`, `ice`
    - Configure the `uv` token so no `text-uv` utility is generated — it measures 3.73:1 on `void` and must never be reachable as a text color
    - Type scale utilities for display / h2 / body / label / countdown
    - _Requirements: 9.6_

  - [ ] 1.3 Configure Netlify deployment
    - `netlify.toml` with the build command, publish dir, and `@netlify/plugin-nextjs`
    - Placeholder `[[headers]]` block for `/*` (populated in task 7.2)
    - _Requirements: 13.1_

  - [ ] 1.4 Set up the Vitest + fast-check harness and `FakeBlobStore`
    - `vitest.config.ts` with the jsdom environment for render tests and node for the rest
    - `tests/fakes/FakeBlobStore.ts`: in-memory `get`, `getWithMetadata`, `set`, `delete`, `list` over the narrow `Store` surface the app uses
    - Include an `eventual` mode that delays write visibility — Property 2 depends on it
    - Default `numRuns` of 100 for all property assertions
    - _Requirements: 13.4_

  - [ ] 1.5 Configure ESLint with the restricted-import zones
    - `no-restricted-imports` forbidding `lib/blobs/media` from every path except `lib/media/serve.ts`
    - Ban `next/image` imports in the archive tree
    - Ban `getDeployStore` from `@netlify/blobs` repo-wide
    - These invariants must fail the build, not a code review
    - _Requirements: 2.1, 13.4_

- [ ] 2. Blob layer and document types

  - [ ] 2.1 Define the document types, key builders, and env accessor
    - `lib/blobs/types.ts`: `ArchiveConfig`, `MediaEntry`, `MediaIndex`, `Visibility`, `VisSummary`, `AttendeeCodeRecord`, `RemovalRecord`, `RateWindow`, `ArchiveState`, `MediaType`, `Variant`
    - `lib/blobs/keys.ts`: pure builders for `arch/{archiveId}/config`, `index`, `vis/{mediaId}`, `vis-summary`, `secret/attendee-code`, `removals/{recordId}`, `rl/{scope}/{ipHash}`, `media/{mediaId}/{variant}`
    - `lib/config/env.ts`: `requireEnv` that throws on missing `FLASHBACK_SESSION_KEY` or `FLASHBACK_ORGANIZER_SECRET`, plus defaulted reads for `FLASHBACK_ARCHIVE_ID`, `FLASHBACK_EVENT_NAME`, `FLASHBACK_EXPIRES_AT`, `FLASHBACK_SITE_ORIGIN`
    - Media keys are built from `entry.mediaId` and a `Variant` union member only — never from a request value
    - _Requirements: 13.4, 13.6, 4.4_

  - [ ] 2.2 Implement the two blob stores
    - `lib/blobs/meta.ts`: `getStore({ name: 'flashback-meta', consistency: 'strong' })` — strong consistency is a property of the store, so Requirement 2.11 holds without call-site discipline
    - `lib/blobs/media.ts`: `getStore({ name: 'flashback-media' })`, store handle not exported
    - Both site-wide via `getStore`; zero deploy-scoped stores
    - Expose the injection seam the `FakeBlobStore` binds to
    - _Requirements: 2.11, 13.4_

  - [ ] 2.3 Implement visibility documents and the derived summary
    - `lib/blobs/vis.ts`: read/write `vis/{mediaId}` with `rev` increment and `reason`, plus `rebuildVisSummary()` from the per-item documents
    - One document per Media_Item so that hides on distinct items touch disjoint keys — Blobs has no compare-and-swap, and a lost hide is a safety failure
    - The summary is display-only and self-healing; the gate never reads it
    - _Requirements: 6.9, 6.10, 5.4_

  - [ ] 2.4 Implement `ensureSeeded` with fail-closed behavior
    - `lib/blobs/seed.ts`: create-if-absent only, never overwrite
    - Absent `config` → write `state: 'LIVE'`, `expiresAt` from `FLASHBACK_EXPIRES_AT` or now + 12 days, `codeVersion: 1`, `eventName` from env
    - Absent `secret/attendee-code` with `FLASHBACK_ATTENDEE_CODE_SEED` set → derive salt + PBKDF2 hash, write at `codeVersion: 1`
    - Absent code record and no seed env → **force `state: 'DISABLED'`** and surface a diagnostic for the Admin_View. An archive with no code must not be an archive with no lock
    - _Requirements: 13.5, 8.2_

  - [ ]* 2.5 Write property test for seeding idempotence
    - **Property 32: Seeding is idempotent and non-destructive**
    - **Validates: Requirements 13.5**

- [ ] 3. Session tokens

  - [ ] 3.1 Implement the edge-safe session module
    - `lib/session/token.ts`: mint and verify `fb1.<payload-b64url>.<sig-b64url>`, HMAC-SHA256 over `fb1.<payload>` keyed by `FLASHBACK_SESSION_KEY` via `crypto.subtle`
    - `SessionPayload` with `r`, `cv`, `iat`, `exp` (iat + 43200), `jti`
    - Portable `timingSafeEqual` over `Uint8Array` — **no `node:crypto`, no `node:` imports at all**, because middleware runs this module in the Deno edge runtime
    - `lib/session/cookies.ts`: serialize `fb_a` / `fb_o` with `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`, plus clear helpers
    - Verification collapses every failure — absent, malformed, wrong prefix, bad signature, `exp <= now`, role/slot mismatch, attendee `cv !== config.codeVersion` — to "carries no session". No distinct status for tampering
    - _Requirements: 1.4, 7.4, 7.5, 7.8, 7.9, 6.7_

  - [ ]* 3.2 Write unit tests for the verification outcome table
    - One case per row: absent, malformed, wrong prefix, wrong segment count, signature mismatch, expired, role swapped between cookie slots
    - _Requirements: 7.9, 14.16_

- [ ] 4. The single authorization gate

  - [ ] 4.1 Implement the ordered chain and the `GateProof` brand
    - `lib/auth/gate.ts` exporting `Role`, `GateDenial`, `GateProof`, `GateResult`, `gateMedia`, `gateView`
    - `declare const proofBrand: unique symbol` so a `GateProof` is constructible only inside this module — bypassing authorization becomes a type error
    - `gateMedia` order, returning at the first failure: session → archive state → expiration → existence → visibility
    - Steps 2, 3, and the `hidden` check in step 5 are skipped for `role === 'organizer'`; the step *order* is fixed regardless, so a session-less request never learns whether the archive is disabled and an expired session never learns whether a Media_ID exists
    - `MEDIA_UNKNOWN`, `MEDIA_HIDDEN`, and `MEDIA_DELETED` all surface as 404, indistinguishable from each other
    - Any throw or unparseable document short-circuits to `503 STATE_UNREADABLE`. **There is no code path where a read failure results in serving bytes**
    - Express visibility as a small array of predicates over `(entry, vis, role)` — the reserved seam for a future consent check
    - `gateView` is the same chain minus existence and visibility
    - Reads exactly two documents per media request: `config` and `vis/{mediaId}`, both strong
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.11, 5.8, 6.4, 6.15, 8.3, 8.6, 8.9, 11.6_

  - [ ] 4.2 Write property test for the gate decision table
    - **Property 1: The gate decides every protected entry point**
    - Build `arbGateScenario`: session kind (none, attendee, organizer, signature-invalid, expired, stale `cv`) × archive state × expiration (past, future) × item state (missing, visible, hidden, deleted) × variant
    - Assert zero media byte reads on every denial by instrumenting the fake media store
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 5.8, 6.4, 8.3, 11.6**

  - [ ] 4.3 Write property test for strong-consistency reads
    - **Property 2: Safety state is never read stale**
    - Run the gate against `FakeBlobStore` in `eventual` mode and assert it still observes the most recent `config` and `vis` writes — i.e. the strong store is the one in use
    - **Validates: Requirements 2.11**

- [ ] 5. Media delivery and Range streaming

  - [ ] 5.1 Implement `serveMedia` and the Range parser
    - `lib/media/serve.ts` — the only module permitted to import `lib/blobs/media`; signature `serveMedia(proof: GateProof, range: string | null): Promise<Response>`
    - `lib/media/range.ts` — `parseRange(header, size)` returning `null` for a syntactically invalid header (treat as absent per RFC 9110), `'unsatisfiable'` when `start >= size`, else `{ start, end, openEnded }`
    - Three response cases, because Netlify Blobs has **no server-side range read**:
      1. No `Range` → `store.get(key, { type: 'stream' })` straight into the response body, `200`
      2. `Range: bytes=0-` → stream the whole object as `206` with `Content-Range: bytes 0-<N-1>/<N>`; treating it as a real partial read would mean fetching 18 MB to return 4 MB
      3. Bounded `bytes=s-e` → `arrayBuffer`, slice, `206`
    - Single range only; multi-range answered `200` with the full object. Non-`bytes` unit treated as absent. Suffix form `bytes=-500` supported. `end` clamped to `size - 1`. Served length clamped to `RANGE_MAX_BYTES = 4 MB`
    - `start >= size` → `416` with `Content-Range: bytes */<size>` and an empty body
    - Assert the fetched length equals `entry.variants[variant].byteLength` before responding; mismatch → `503`, never a truncated body
    - No `ETag`, `Last-Modified`, `If-Range`, or `If-None-Match` — there is nothing to validate under `no-store`
    - _Requirements: 2.1, 3.1, 3.2, 13.3_

  - [ ] 5.2 Implement the Media_API route
    - `app/api/media/[id]/route.ts` with `GET` and `HEAD`, `?v=full|thumb|poster` defaulting to `full`
    - `export const dynamic = 'force-dynamic'`, `revalidate = 0`, `fetchCache = 'force-no-store'` — a cached authorization decision is an authorization bypass
    - Call `gateMedia` first, map denials to their status with the fixed bodies, pass the proof to `serveMedia`
    - Response headers on 2xx: `Content-Type`, exact `Content-Length`, `Cache-Control: private, no-store`, `Vary: Cookie`, `X-Content-Type-Options: nosniff`, and `Accept-Ranges: bytes` for video
    - `HEAD` returns the identical header set with a zero-length body
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.2, 12.6_

  - [ ] 5.3 Write property test for Range responses
    - **Property 8: Range responses return exactly the bytes they describe**
    - Build `arbRange`: valid, suffix, open-ended, inverted, past-end, zero-length, and non-`bytes` unit forms against object sizes from 1 byte to 18 MB
    - **Validates: Requirements 3.1, 3.2**

- [ ] 6. Rate limiting and the access flow

  - [ ] 6.1 Implement the Blobs-backed sliding-window rate limiter
    - `lib/ratelimit/index.ts` over `arch/{archiveId}/rl/{scope}/{ipHash}` holding `{ schema: 1, hits: number[] }`
    - `ipHash = base64url(HMAC-SHA256(FLASHBACK_SESSION_KEY, `${ip}|${scope}|${utcDate}`))[0..21]` — **the raw IP is never stored**, and the UTC-date salt means the key is not a stable cross-day identifier
    - Client IP from `x-nf-client-connection-ip`, falling back to the first `x-forwarded-for` entry for local dev only, since that header is client-spoofable
    - Prune `hits` to the trailing 60,000 ms, compare against the limit, append on a countable event, cap the array at `limit + 1`
    - True sliding window, not fixed buckets — fixed buckets would permit 2× the limit across a boundary
    - Scopes: `access` 10 (failed submissions), `removal` 20 (accepted requests), `admin-login` 5 (failed submissions)
    - `429` carries `Retry-After: 60`
    - _Requirements: 1.8, 1.9, 5.9, 5.6, 11.1_

  - [ ] 6.2 Implement code generation and normalization
    - `lib/access/code.ts` with alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 chars, excluding `0 O 1 I L`), default length 10, permitted 8–12
    - Draw from `crypto.getRandomValues` with rejection sampling (reject bytes ≥ 248 before `% 31`) so the distribution is uniform
    - `normalize(input) = input.replace(/\s+/g, '').toUpperCase()` — strips leading, trailing, and internal whitespace
    - PBKDF2-HMAC-SHA256, 210,000 iterations, 32-byte output, 16-byte salt; derive and verify helpers
    - _Requirements: 1.6, 1.7, 1.3_

  - [ ] 6.3 Implement the Access_API
    - `app/api/access/route.ts`, `POST`, force-dynamic
    - Order: rate-limit `access` → `429`; `ensureSeeded()` then strong `config` read; `state !== 'LIVE'` → `403`; `now >= expiresAt` → `403`; then read `AttendeeCodeRecord`, derive over `normalize(input)`, compare with `timingSafeEqual`
    - State and expiry checks precede the hash comparison, so a disabled or expired archive returns 403 for the correct code too, and cheaply
    - Mismatch → record a rate-limit hit, respond `401` with the fixed body `{"error":"INVALID"}` and **no `Set-Cookie`**. No length hint, no character feedback, no timing branch on code content
    - Match → mint `fb_a` with `cv: config.codeVersion`, `303` redirect to `/archive`
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.10, 1.11, 6.4, 8.3_

  - [ ] 6.4 Build the functional Access_Screen and Archive_View shells
    - `app/page.tsx`: server component, force-dynamic, reads `config` strong; renders the FLASHBACK name, `QLICK QRAVE`, the private-archive line, one code input, one submit control — and **zero photographs and zero video elements**
    - `app/archive/page.tsx`: server component, force-dynamic, calls `gateView`, renders the featured video and the photo grid
    - `components/MediaTile.tsx`: references media exclusively through `/api/media/{mediaId}` URLs, carries the Reference_Label and generic alt text, exposes zero original filenames in markup, attributes, or embedded JSON
    - Correct structure and semantics only — visual identity lands in tasks 13 and 14. This shell is what makes the early deployed verification possible
    - _Requirements: 1.1, 1.2, 2.10, 9.3_

  - [ ] 6.5 Write property test for session token well-formedness and rejection
    - **Property 4: Session tokens are well-formed, and anything else is no session**
    - Covers the cookie attribute set, the 12-hour lifetime, the `303` to `/archive` on successful issuance, and every not-produced-by-the-current-key cookie value
    - **Validates: Requirements 1.4, 1.11, 7.4, 7.8, 7.9**

  - [ ] 6.6 Write property test for source-identity non-disclosure in rendered output
    - **Property 12: Rendered output leaks no source identity**
    - Build `arbMediaIndex` with adversarial original filenames (`IMG_2847 Sabrina backstage 2024-11-16 GPS.jpg`, unicode, path separators), 0–60 entries
    - Also asserts the unauthenticated Access_Screen response contains zero Media_Item references
    - **Validates: Requirements 1.2, 2.10**

  - [ ]* 6.7 Write property test for code verification
    - **Property 3: Code verification is normalization-invariant and rejects everything else**
    - **Validates: Requirements 1.3, 1.5, 1.6**

  - [ ]* 6.8 Write property test for code transcribability
    - **Property 29: Generated codes are transcribable**
    - **Validates: Requirements 1.7**

  - [ ]* 6.9 Write property test for the rate limiter window
    - **Property 30: The rate limiter bounds a single client's window**
    - **Validates: Requirements 1.8, 1.9, 5.9**

- [ ] 7. Security headers, CSP, and indexing

  - [ ] 7.1 Implement middleware with the per-request CSP nonce
    - `middleware.ts` + `lib/security/csp.ts` building the policy with `default-src 'self'`, `frame-ancestors 'none'`, `script-src 'self' 'nonce-{N}' 'strict-dynamic'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`, `media-src 'self'`, `font-src 'self'`, `connect-src 'self'`, `form-action 'self'`, `base-uri 'none'`, `object-src 'none'`, `frame-src 'none'`, `worker-src 'self'`, `manifest-src 'self'`, `upgrade-insecure-requests`
    - **Set the CSP on both the outgoing response and the forwarded request headers** via `NextResponse.next({ request: { headers } })` — Next reads the nonce out of the request CSP header to stamp its bootstrap and Flight scripts, and skipping that half is how this silently breaks in production
    - Coarse status only: `/archive` with no valid-signature cookie → `307` to `/`; `/admin` with valid `fb_o` → pass; `/admin` with only `fb_a` → `403`; `/admin` with neither → `401`. The 401/403 body is a minimal self-contained document carrying the organizer secret form posting to `/api/admin/session`
    - Middleware verifies only the cookie *signature*. It reads no blobs and checks no archive state, expiration, code version, or visibility — **it is not the authorization boundary**
    - _Requirements: 12.1, 7.2, 7.3, 11.6, 14.4_

  - [ ] 7.2 Add the static header set to `next.config.ts` and `netlify.toml`
    - `headers()` for `/(.*)`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, `X-Robots-Tag: noindex, nofollow`, `X-Frame-Options: DENY`
    - The same set in `netlify.toml` `[[headers]]` for `/*`, covering assets served straight off the CDN that never reach the Next handler. Duplicated headers are harmless; a missing one on a static path is not
    - _Requirements: 11.3, 12.2, 12.3, 12.4, 12.5, 12.7_

  - [ ] 7.3 Add `robots.ts` and the page-level robots metadata
    - `app/robots.ts` returning `User-agent: *` / `Disallow: /`
    - `metadata` export in `app/layout.tsx` with `robots: { index: false, follow: false }`
    - Neither is a security control; the gate is
    - _Requirements: 11.4, 11.5, 11.6_

  - [ ] 7.4 Write property test for the security header set
    - **Property 9: Every response carries the full security header set**
    - Iterate the application's route table × session state
    - **Validates: Requirements 11.3, 11.4, 12.1, 12.2, 12.3, 12.4, 12.5**

  - [ ] 7.5 Write property test for cache and `Vary` behavior
    - **Property 10: Protected responses are never cacheable and always vary on cookie**
    - Assert `Cache-Control: private, no-store`, `Vary: Cookie`, and the absence of `ETag`, `Last-Modified`, and `Age`
    - **Validates: Requirements 2.8, 12.6**

- [ ] 8. First deploy and partial deployed verification

  - [ ] 8.1 Implement the first tranche of `scripts/verify-deployed.ts`
    - `npm run verify -- --url <site> --code <code> --secret <secret>` using plain `fetch`, no headless browser, non-zero exit on any failure
    - This tranche covers the checks that need no ingested media: wrong code → 401 with no cookie (14.2), correct code → session and Archive_View access (14.3), Archive_View with no cookie → redirect or 401 with zero Media_Item references (14.4), random Media_ID with a valid session → 404 with zero bytes (14.8), expired cookie → 401 from the Media_API (14.16)
    - Plus the header assertions from Requirement 12 and the `robots.txt` body
    - Structure it so the remaining checks slot in later without rewriting the runner
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.8, 14.16_

  - [ ] 8.2 Deploy to Netlify and run the partial verification
    - Create the site, link the repo, set `FLASHBACK_SESSION_KEY` and `FLASHBACK_ORGANIZER_SECRET` (plus `FLASHBACK_ATTENDEE_CODE_SEED` for this pass so a code exists before ingest runs)
    - Run `npm run verify` against the deployed URL and fix anything it reports
    - Local `netlify dev` uses a sandboxed store and cannot see production blobs, which is exactly why this runs against the deployed site
    - _Requirements: 14.1, 12.7, 13.1_

- [ ] 9. Checkpoint - security core verified against a live URL
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Anonymous removal requests

  - [ ] 10.1 Implement the Removal_API
    - `app/api/removal/route.ts`, `POST`, body `{ mediaId, note? }`
    - Order: `gateView` → `401`; rate-limit `removal` at 20/60s → `429`; validate `mediaId` exists in the index and `note` trimmed is ≤1000 chars else `400`
    - **Construct the record from an explicit allowlist, never by spreading the parsed body**: `schema`, `recordId` (16 random bytes), `mediaId` taken from the index entry rather than the payload, `submittedAt`, optional `note`, `status: 'PENDING'`. Extra payload fields are structurally unreachable
    - No IP, no user agent, no `Referer`, no session id, nothing derived from the request beyond the two accepted fields
    - **Write `vis/{mediaId}` with `hidden: true` before writing the record, and both before responding** — the strong store makes the hide immediately effective, so a media request issued the instant the response lands already returns 404
    - Rebuild `vis-summary`, respond `200 { ok: true, hidden: true }`. If the record write fails, still return `200` with the hide in place and log it — losing the audit record is bad, leaving the media visible is worse
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.8, 5.9, 11.1, 15.2_

  - [ ] 10.2 Write property test for removal record field allowlisting
    - **Property 14: Removal records contain exactly the allowlisted fields**
    - Build `arbRemovalPayload`: valid bodies plus arbitrary extra keys, prototype-pollution shapes, oversized notes, and header sets carrying IPs and user agents
    - **Validates: Requirements 5.2, 5.3, 5.5, 5.6, 11.1, 15.2**

  - [ ] 10.3 Write property test for hide-before-respond ordering
    - **Property 15: A removal request hides before it responds**
    - **Validates: Requirements 5.4, 5.7**

- [ ] 11. Organizer authentication and the Admin_API

  - [ ] 11.1 Implement `withOrganizer` and the organizer session routes
    - `lib/auth/organizer.ts`: verify `fb_o` → `401` on failure; reject a request bearing only `fb_a` → `403`; check `Origin` against `FLASHBACK_SITE_ORIGIN` or Netlify's `URL` → `403` on mismatch **or absence**; then `ensureSeeded()` and read `config`. No handler body runs, and therefore no write occurs, unless all of it passes
    - `app/api/admin/session/route.ts`: compare against `FLASHBACK_ORGANIZER_SECRET` read from env with `timingSafeEqual` — no blob read, no persisted copy. Mint `fb_o` with `cv: 0`. Own rate-limit scope at 5/60s
    - `app/api/admin/session/logout/route.ts`: clear `fb_o`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 13.6_

  - [ ] 11.2 Implement the state and expiration routes
    - `POST /api/admin/state` writing `config.state`, so the next Media_API strong read observes it
    - `POST /api/admin/expiration` writing `config.expiresAt`, **accepting past values and accepting submissions made while already expired**
    - _Requirements: 6.3, 6.5, 6.8, 8.7_

  - [ ] 11.3 Implement code rotation
    - `POST /api/admin/code/rotate`: generate a new code, write the `AttendeeCodeRecord` **first**, then `config` with the bumped `codeVersion`. If the second write fails, the old code still validates and old sessions still work — degraded but coherent; the reverse order would leave a window with no valid code at all
    - Return the plaintext in the response body exactly once. Never written to a blob, never logged
    - The `codeVersion` bump is what invalidates every previously issued attendee token; organizer sessions carry `cv: 0` and are never compared, so rotation does not lock the Organizer out mid-task
    - _Requirements: 6.6, 6.7_

  - [ ] 11.4 Implement per-item visibility
    - `POST /api/admin/media/[id]/visibility` with `{ hidden: boolean }`, writing `vis/{id}` and rebuilding the summary. Bytes are retained on hide
    - _Requirements: 6.9, 6.10_

  - [ ] 11.5 Implement per-item delete and delete-all with typed confirmation
    - `POST /api/admin/media/[id]/delete` requires `confirm === "DELETE <label>"`; `POST /api/admin/media/delete-all` requires `confirm === "DELETE ALL <n> ITEMS"` with `n` from the current index. Exact comparison, wrong case fails
    - Mismatch or absence → `400 CONFIRM_REQUIRED` and **zero blob deletions**. The check runs before the media store handle is obtained, so a failed confirmation cannot partially delete
    - Per item: set `vis.deleted = true` first (immediately effective, gate now 404s), then remove every variant's bytes. If byte removal fails the item is already unreachable and the delete is retryable
    - Delete-all iterates sequentially, reports per-item outcomes, and is idempotent on retry
    - _Requirements: 6.11, 6.12, 6.13_

  - [ ] 11.6 Implement removal review
    - `POST /api/admin/removals/[recordId]/review` updating `status` only. **It never touches `vis`** — restoring is a separate, deliberate Organizer action
    - _Requirements: 6.14_

  - [ ] 11.7 Write property test for privilege separation
    - **Property 6: Organizer privileges come only from an organizer session**
    - Assert persisted state is byte-identical before and after every rejected request
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.5, 7.6**

  - [ ] 11.8 Write property test for the Origin check
    - **Property 7: Cross-origin state change is refused**
    - **Validates: Requirements 7.7**

  - [ ] 11.9 Write property test for rotation and session invalidation
    - **Property 5: Rotation replaces the code and invalidates prior attendee sessions**
    - **Validates: Requirements 6.6, 6.7**

  - [ ] 11.10 Write property test for deletion
    - **Property 18: Deletion is confirmed, scoped, and complete**
    - **Validates: Requirements 6.11, 6.12, 6.13**

  - [ ]* 11.11 Write property test for state and visibility round trips
    - **Property 17: State toggles are round trips**
    - **Validates: Requirements 6.3, 6.5, 6.9, 6.10, 6.15**

  - [ ]* 11.12 Write property test for review non-restoration
    - **Property 16: Review does not restore visibility**
    - **Validates: Requirements 6.14**

  - [ ]* 11.13 Write property test for expiration persistence
    - **Property 20: Expiration changes persist**
    - **Validates: Requirements 6.8, 8.7**

  - [ ]* 11.14 Write property test for concurrent visibility mutations
    - **Property 19: Concurrent visibility mutations are confluent**
    - **Validates: Requirements 5.4, 6.9, 6.11**

- [ ] 12. Admin_View

  - [ ] 12.1 Build the server-rendered Admin_View
    - `app/admin/page.tsx`, force-dynamic, no client data fetching. Reads `config`, `index`, every `vis/{id}` document (rebuilding `vis-summary` as a side effect), and lists `removals/` to count `PENDING`
    - Displays event name, Archive_State, Expiration_Timestamp, photograph count, video count, pending removal count
    - Controls for disable, enable, change expiration, rotate code, hide, restore, delete, delete-all, and review — every mutation a `<form>` posting to its route then redirecting back to `/admin`. No client state, no optimistic UI, nothing to desync
    - Hidden items render with a visible `HIDDEN` marker and a live preview through the Media_API authorized by the organizer session
    - Delete controls require the Organizer to type the confirmation string; there is no one-click delete
    - Distribution text block: event name, site origin, code, formatted expiry. Since the plaintext is not stored, it shows the real code only in the render immediately following a rotation; otherwise a placeholder with a rotate affordance
    - `Cache-Control: private, no-store` on the page holding a freshly rotated plaintext
    - Surface the `ensureSeeded` fail-closed diagnostic when no code record exists
    - _Requirements: 6.1, 6.2, 6.15, 8.6, 15.3, 12.6_

  - [ ]* 12.2 Write property test for derived display values
    - **Property 23: Derived display values equal computed values**
    - **Validates: Requirements 6.1, 8.1, 15.3**

  - [ ]* 12.3 Implement the rate-limit key sweep on Admin_View load
    - `list({ prefix: 'rl/' })`, delete documents whose newest hit is older than 5 minutes. Blobs has no TTL, and keys are otherwise only pruned lazily on read
    - Deferrable: key accumulation is a housekeeping concern, and the answer to a determined attacker is the disable control, not the limiter
    - _Requirements: 1.8, 5.9_

- [ ] 13. Attendee surfaces

  - [ ] 13.1 Build the full Access_Screen with the ended state
    - Wordmark, event name, the private-archive line, the code input, and the submit control
    - `now >= expiresAt` → render `THIS FLASHBACK HAS ENDED.` **in place of the code input**
    - Failure state renders as an in-identity `acid`-on-black terminal message with a route back to `/`, disclosing nothing about the expected value
    - Still zero photographs and zero video elements
    - _Requirements: 1.1, 1.2, 8.5_

  - [ ] 13.2 Build the full Archive_View
    - Sticky 32 px hairline bar with the wordmark and countdown; event name bleeding full width; featured video; privacy notice; full-bleed photo grid at 1 col @375 / 2 @640 / 3 @1024 / 4 @1536; footer
    - Featured video capped at `max-height: 38vh` so at least one full grid row is visible at 375 × 667 — the concrete reading of "photographs get the largest share of the viewport"
    - `<video>` with `controls muted playsInline preload="metadata" controlsList="nodownload noplaybackrate" disablePictureInPicture`, `poster` via `?v=poster`, **no `autoplay`**, and `muted` as a default attribute rather than a fixed React prop so the volume control still works
    - `now >= expiresAt` → full black with scanlines and `THIS FLASHBACK HAS ENDED.`, **zero Media_Items and zero media references in the markup**
    - _Requirements: 3.3, 3.4, 3.6, 8.4, 9.1, 9.2, 10.1_

  - [ ] 13.3 Build the media tile
    - Plain `<img>` only — `next/image` is banned because on Netlify it routes through the Image CDN, which caches transformed output outside the gate
    - `loading="lazy"`, `decoding="async"`, and intrinsic `width`/`height` from the index so nothing reflows; `aspect-ratio` computed from stored dimensions
    - Grid serves `?v=thumb` (~60–90 KB); the 1 MB `full` derivative is fetched only on lightbox open, which is what keeps a grid load near 3 MB under `no-store`
    - Alt text `Photograph QLK 017 from Qlick QRave` — deliberately generic. Auto-describing the people would manufacture exactly the identifying description this project exists to avoid
    - Deterrents: `onDragStart` and `onContextMenu` calling `preventDefault`, plus `draggable={false}` and `user-select: none`
    - Hover changes only the hairline color to `acid` — no scale transform, so 40 tiles stay smooth and the reduced-motion path is identical to the default
    - _Requirements: 9.3, 9.6, 10.1, 10.2, 10.3, 2.10_

  - [ ] 13.4 Build the countdown, privacy notice, and footer
    - Countdown in days, hours, minutes. Mono `tabular-nums`, digits `flash`, units `smoke`, on a `siren` hairline whose width is the fraction of the window remaining. Under 24 hours the digits turn `siren` with a 1.2 s opacity pulse. Rendered from a server-supplied ISO string and ticked client-side every 30 s **for display only** — the server value is the only one that authorizes anything
    - Privacy notice: persistent block between the video and the grid, `bone` on `tar` with a `uv` left rule, asking viewers not to identify, tag, download, screenshot, record, or redistribute anyone depicted, and linking to the removal control. Not dismissible
    - Copy describes download and screenshot measures as **deterrents** and makes no claim of screenshot prevention, because a website cannot
    - Footer is exactly `Built with PLUR by film.fyi` with the hyperlink on `film.fyi` alone
    - Zero hire-me content, contact forms, newsletter fields, portfolio links, advertising, or lead capture anywhere
    - _Requirements: 8.1, 8.9, 9.4, 9.8, 9.9, 10.4_

  - [ ] 13.5 Build the removal control and modal
    - A removal control adjacent to every visible Media_Item, posting `{ mediaId, note? }` to `/api/removal`
    - Note field capped at 1000 characters with the cap stated in the copy
    - On success, replace the tile in place with a confirmation that the item **is already hidden** and the Organizer will review
    - Modal traps focus, returns it to the invoking control on close, closes on Escape, and is labelled by its heading
    - _Requirements: 5.1, 5.7, 9.7_

  - [ ]* 13.6 Write property test for tile completeness
    - **Property 13: Every visible tile is complete and every hidden one is absent**
    - **Validates: Requirements 5.1, 9.3, 9.6, 10.2, 10.3**

  - [ ]* 13.7 Write property test for expiry behavior
    - **Property 21: Expiry stops attendees and destroys nothing**
    - **Validates: Requirements 8.4, 8.5, 8.6, 8.8**

  - [ ]* 13.8 Write example tests for copy, attributes, and layout caps
    - Access_Screen inventory (1.1), video attribute set (3.3, 3.4, 3.6), no download control and deterrent wording (10.1, 10.4), privacy notice copy (9.4), footer text and link scope (9.8), absence of promotional content (9.9), single column at 375 px and the 38vh video cap (9.1, 9.2), `robots.txt` body (11.5), default expiration of 12 days (8.2), keyboard traversal (9.7)
    - _Requirements: 1.1, 3.3, 3.4, 3.6, 8.2, 9.1, 9.2, 9.4, 9.7, 9.8, 9.9, 10.1, 10.4, 11.5_

  - [ ]* 13.9 Write property test for time-value independence
    - **Property 22: Authorization ignores client-supplied time**
    - **Validates: Requirements 8.9**

- [ ] 14. Visual system

  - [ ] 14.1 Self-host the two type families
    - Anton (400) and IBM Plex Mono (400, 600) as committed woff2 subsets loaded through `next/font/local`, so `font-src 'self'` holds and there is not one third-party request in the app
    - Display: Anton, uppercase, `clamp(2.75rem, 12vw, 9rem)`, `-0.035em`, `0.82` leading. Body: Plex Mono at `0.9375rem/1.65`, `-0.005em`. Label: `0.6875rem`, uppercase, `0.28em` tracking, weight 600
    - _Requirements: 11.2_

  - [ ] 14.2 Implement the effect layers
    - All of them `pointer-events: none` fixed overlays or static filters; none intercept input, none are required to read anything
    - Grain: inline SVG `feTurbulence` data URI (`baseFrequency="0.85" numOctaves="4"`) tiled at 220 px, `z-index: 50`, `opacity: .16`, `mix-blend-mode: overlay`, animated by stepping `background-position` through 8 discrete positions with `steps(8)` so it flickers like film rather than sliding. A data URI keeps it inside `img-src 'self' data:` with zero extra requests
    - Scanlines: `repeating-linear-gradient` at `z-index: 40` with a 6 s 1px vertical drift, on the featured video frame and the ended state
    - Light leak: two blurred `radial-gradient` blobs, `uv` at 10% and `siren` at 7%, `blur(90px)`, drifting on a 60 s `translate3d` loop
    - Vignette: `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,.7) 100%)` fixed at `z-index: 45`
    - Taped labels: `QLK NNN` chips at `rotate(-0.4deg)` with a 1px `ash` hairline, a 2px hard offset shadow, and alternating rotation by index parity
    - **Xerox filter is never applied to a Media_Item** — the photographs are the Photographer's finished edit; only decorative chrome looks photocopied
    - _Requirements: 9.3, 11.2_

  - [ ] 14.3 Implement the single-flash transition and the reduced-motion block
    - One full-viewport `flash` white-out for 120 ms then a cut to black, played **exactly once** on a successful code entry
    - **This is a photosensitivity constraint, not a style detail.** WCAG 2.3.1 sets a three-flash threshold. Hard-cap at one flash, never repeated, never looped, **not triggered on the failure path** (a wrong code must not produce a reward stimulus), and fully removed under `prefers-reduced-motion: reduce` where the transition is an instant state change. No other element in the app flashes, blinks, or strobes
    - One reduced-motion block: `animation: none !important; transition: none !important` on the effect utilities, grain frozen to a single frame, no flash, no countdown pulse. Every control, the video, and the removal flow behave identically
    - _Requirements: 9.5_

  - [ ] 14.4 Apply focus rings and enforce the token contrast rules
    - `outline: 2px solid acid; outline-offset: 2px` globally. `outline: none` appears nowhere
    - Confirm each body-text token measures ≥4.5:1 on both `void` and `tar`, and that `uv` (3.73:1 / 3.52:1) has no text utility path
    - _Requirements: 9.6, 9.7_

  - [ ]* 14.5 Write property test for text contrast
    - **Property 34: Body text meets contrast on every surface**
    - **Validates: Requirements 9.6**

  - [ ]* 14.6 Write property test for subresource origin
    - **Property 33: Every subresource is same-origin**
    - **Validates: Requirements 11.2**

  - [ ]* 14.7 Add chromatic fringe and xerox chrome polish
    - Static `text-shadow` fringe on display type (`ice` left, `siren` right) — static, so it is not motion and stays on under reduced motion
    - `grayscale(1) contrast(1.75) brightness(1.05)` on decorative chrome marks only
    - Cut this first if the timeline tightens; the base look reads correctly without it
    - _Requirements: 9.5_

- [ ] 15. Ingest pipeline

  - [ ] 15.1 Implement discovery, the CLI, and the run report
    - `scripts/ingest/index.ts` run as `npm run ingest -- ./photos [options]` via `tsx`. Never runs on Netlify
    - `getStore` with explicit `siteID` and `token` from `NETLIFY_SITE_ID` and `NETLIFY_API_TOKEN`, read from `.env.ingest.local`. Refuse to start if either is missing and print the variable names wanted. Local `netlify dev` uses a sandboxed store and cannot reach production blobs
    - Non-recursive discovery. Photos `.jpg .jpeg .png .heic .heif .webp .tif .tiff`; video `.mp4 .mov .m4v`; RAW `.cr2 .cr3 .nef .arw .orf .rw2 .raf .dng .srw .pef` **skipped and reported by name**; anything else ignored with a note
    - Everything read-only — `fs.readFile` and `spawn ffmpeg -i`. No in-place operation exists in the script and there is no write path to the input directory
    - Per-file report lines (`OK`, `SKIP raw`, `FAIL <reason>`); a failure on one file never aborts the run; **non-zero exit if any file failed** so a mistake is not silently shipped
    - `--dry-run` does everything except write to Blobs — how the Photographer checks sizes and stripping before touching production
    - _Requirements: 4.1, 4.5, 4.9, 4.10_

  - [ ] 15.2 Implement the sharp photo pipeline
    - `rotate()` with no argument **first**, so applying EXIF orientation to the pixels survives discarding EXIF
    - `resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })`
    - `.jpeg({ quality: q, progressive: true, chromaSubsampling: '4:2:0', mozjpeg: true })` with a quality ladder `84 → 78 → 72 → 66 → 60`, stopping at the first output ≤1 MB. If 60 still exceeds it, step the longest edge to 2000 then 1800 and retry the ladder
    - `thumb` variant: same pipeline at 640 px, quality 74
    - **Never call `withMetadata()`** — sharp drops all metadata by default and calling it would put some back
    - Convert to sRGB and embed no ICC profile: an sRGB tag is not private data, but a custom camera profile is a camera fingerprint
    - _Requirements: 4.2_

  - [ ] 15.3 Implement two-tool metadata verification
    - `sharp(buf).metadata()` must report `exif`, `iptc`, `xmp`, and `icc` all undefined
    - `exiftool -j -G` on the buffer must return a tag set that is a **subset of a fixed allowlist**: `SourceFile`, `ExifToolVersion`, and the `File:*` / `JFIF:*` groups. Any tag in `EXIF`, `GPS`, `IPTC`, `XMP`, `MakerNotes`, `ICC_Profile`, `Photoshop`, or `Composite` fails the file
    - Group-level rejection is what catches face regions, which hide in `XMP-mwg-rs` and `MakerNotes` and survive a naive strip-EXIF pass
    - **A file that fails verification is not written** and is reported as failed
    - _Requirements: 4.3_

  - [ ] 15.4 Implement the ffmpeg video pipeline and poster extraction
    - `-map_metadata -1 -map_chapters -1 -map 0:v:0 -c:v libx264 -profile:v high -level 4.0 -preset slow -pix_fmt yuv420p -vf "scale='min(1920,iw)':-2" -b:v <target> -maxrate <1.5x> -bufsize <3x> -movflags +faststart -f mp4`
    - Verify with `ffprobe -show_format -show_streams`: format and stream tag maps must be empty apart from `encoder`, `major_brand`, `minor_version`, `compatible_brands`, `handler_name`
    - `+faststart` moves the moov atom to the front; without it range-based seeking is useless
    - Target bitrate computed from duration to land at ~90% of `MAX_VIDEO_BYTES` (18 MB), verified against the actual output, one retry at 80% of the previous bitrate on over-size
    - Audio per file: default `-c:a aac -b:a 128k`; `--mute <file>` → `-an`; `--audio <file>=<track.m4a>` → `-i track -map 1:a:0 -c:a aac -b:a 160k -shortest`
    - Poster: `ffmpeg -ss <10% of duration> -frames:v 1` piped through the same sharp photo pipeline, so it is metadata-verified on exactly the same path as a photograph
    - **Contingency, inside this task:** if the deployed check for a full 18 MB video response fails on the free tier, drop `MAX_VIDEO_BYTES` to 5 MB and re-encode. Expose it as one config constant so the ship is never blocked on it and no new service is introduced
    - _Requirements: 3.5, 4.8, 13.3, 13.7_

  - [ ] 15.5 Implement ID generation, labels, byte writes, index, and code seeding
    - Media_ID: `base64url(crypto.randomBytes(16))` → 22 chars, 128 bits. Nothing derived from the filename, timestamp, or ordinal; collisions checked against the in-progress index
    - Write one key per variant at `arch/{archiveId}/media/{mediaId}/{variant}` with `contentType` set. **Immediately read the key's length back and compare**; mismatch fails the file. The media store is eventually consistent, so the readback retries with backoff for up to 10 s before failing
    - Reference_Labels assigned after all files process, ordered by source `mtime` ascending then filename, as `QLK ` + the 1-based ordinal zero-padded to three digits from `QLK 001`. Ordinal → label is a pure function
    - Write a `vis/{mediaId}` document per entry with `hidden: false, deleted: false, reason: 'INGEST'`
    - **Write the index last**, in one `set`. Until it lands, orphan bytes exist but no route can reach them, because the gate's existence check consults the index
    - If `secret/attendee-code` is absent, generate a 10-character code, persist salt + hash at `codeVersion: 1`, and print the plaintext to stdout once with a warning that it will not be shown again — this keeps the plaintext out of Netlify env vars entirely
    - _Requirements: 2.9, 4.4, 4.6, 4.7, 13.5_

  - [ ] 15.6 Write property test for Media_ID opacity
    - **Property 11: Media identifiers are opaque and unique**
    - **Validates: Requirements 2.9**

  - [ ] 15.7 Write property test for metadata stripping
    - **Property 25: Derivatives carry no embedded metadata**
    - Build `arbImage`: small synthetic images with injected EXIF, GPS, IPTC, `XMP-mwg-rs` face regions, and MakerNotes. Keep dimensions small so 100 sharp encodes stay fast
    - Assert that a derivative failing verification is **not** written
    - **Validates: Requirements 4.3**

  - [ ]* 15.8 Write property test for source preservation and file accounting
    - **Property 24: Ingest preserves sources and accounts for every file**
    - **Validates: Requirements 4.1, 4.5, 4.9**

  - [ ]* 15.9 Write property test for derivative size bounds
    - **Property 26: Derivatives fit within their size bounds**
    - **Validates: Requirements 4.2, 4.8, 13.3**

  - [ ]* 15.10 Write property test for index/store agreement
    - **Property 27: Index and blob store agree after ingest**
    - **Validates: Requirements 4.4, 4.6**

  - [ ]* 15.11 Write property test for label assignment
    - **Property 28: Reference labels are a total ordered function of position**
    - **Validates: Requirements 4.7**

  - [ ]* 15.12 Write example tests for the video pipeline
    - Fixture runs for the default, `--mute`, and `--audio` paths, plus the ffprobe tag assertion and the size bound. Video encoding is deliberately not property-tested — one invocation costs seconds and 100 iterations is minutes for a deterministic external binary
    - _Requirements: 3.5, 4.8_

- [ ] 16. Complete the deployed verification script

  - [ ] 16.1 Extend `scripts/verify-deployed.ts` to all 16 checks
    - Add the media-dependent and admin checks to the tranche from task 8.1: photo Media_API with no cookie → 401 with zero bytes (14.5), video Media_API with no cookie → 401 with zero bytes (14.6), a Media_API URL in a session holding no `fb_a` → 401 with zero bytes (14.7), hidden item with a valid attendee session → 404 with zero bytes (14.9), **disable → attendee Media_API 403 within 5 seconds as a timed assertion** (14.10), enable → 200 (14.11), past expiration → Access_API 403 and `THIS FLASHBACK HAS ENDED.` on the Access_Screen (14.12), removal with only a Media_ID → stored record and an immediately hidden item (14.13), Admin_View and every state-changing Admin_API route with only an attendee session → 403 with no state change (14.14), Admin_View with a valid organizer session → the counts from Requirement 6 (14.15)
    - Restore the archive to `LIVE` with the intended expiration at the end of the run
    - Non-zero exit on any failure; no headless browser dependency
    - _Requirements: 14.1, 14.5, 14.6, 14.7, 14.9, 14.10, 14.11, 14.12, 14.13, 14.14, 14.15_

  - [ ] 16.2 Write property test for secret non-disclosure
    - **Property 31: Secrets never appear in output**
    - Scan every route response body, every asset in the built client bundle, and every value written to the Blob_Store for the Organizer_Secret, the session signing key, the Attendee_Code plaintext, its hash, and its salt
    - **Validates: Requirements 1.10, 13.6**

- [ ] 17. Checkpoint - full local suite green
  - Ensure all tests pass, ask the user if questions arise. Every Tier 1 property (1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 25, 31) must be passing before the handoff tasks begin.

- [ ] 18. Production deploy, real ingest, and deployed verification

  - [ ] 18.1 Deploy and configure production environment variables
    - Deploy the completed build to the Netlify site
    - Set site-scoped `FLASHBACK_SESSION_KEY` (32 random bytes, base64) and `FLASHBACK_ORGANIZER_SECRET`; set `FLASHBACK_EXPIRES_AT`, `FLASHBACK_ARCHIVE_ID`, `FLASHBACK_EVENT_NAME`, and `FLASHBACK_SITE_ORIGIN` as needed
    - **Remove `FLASHBACK_ATTENDEE_CODE_SEED`** from the task 8.2 pass so the ingest run owns code seeding and no plaintext sits in an env var
    - Confirm the app refuses to start without the session key or organizer secret
    - _Requirements: 13.5, 13.6, 12.7_

  - [ ] 18.2 Run the real ingest against production blobs
    - Populate `.env.ingest.local` with `NETLIFY_SITE_ID` and `NETLIFY_API_TOKEN`, and confirm it is gitignored
    - `npm run ingest -- <dir> --dry-run` first to review sizes, RAW skips, and stripping results, then the real run
    - **This runs against production blobs, not a local store** — `netlify dev` uses a sandboxed store that cannot see production data, which is why there is no local shortcut here
    - Capture the seeded Attendee_Code plaintext from stdout; it is printed once and never again
    - Confirm the run exits zero. Any failed file means a derivative that was correctly not written
    - Set `featuredMediaId` on the config to the intended video
    - _Requirements: 4.1, 4.4, 4.6, 4.8, 4.10, 13.5_

  - [ ] 18.3 Execute the full deployed verification
    - `npm run verify -- --url <site> --code <code> --secret <secret>` against the live URL with real media present
    - All 16 checks must pass. **A successful local build is explicitly not sufficient evidence** — this run is the definition of done
    - If the 18 MB video response fails on the free tier, apply the `MAX_VIDEO_BYTES` contingency from task 15.4 and re-run
    - Record the results and leave the archive `LIVE` with the intended expiration
    - _Requirements: 14.1 through 14.16, 13.3, 13.7_

  - [ ] 18.4 Write the README handoff document
    - The Ingest_Script command with its options and the `--dry-run` flag
    - The required environment variables **by name only**, with the site/ingest scope split
    - Where the disable control lives on the Admin_View and what it does
    - The attendee URL and Admin_View URL. The Attendee_Code and Organizer_Secret are handed over out of band, never committed
    - _Requirements: 15.1, 15.4_

- [ ] 19. Final checkpoint - handoff ready
  - Ensure all tests pass and the deployed verification is green, ask the user if questions arise.

- [ ] 20. Deferred polish

  - [ ]* 20.1 Extended accessibility pass beyond the required baseline
    - The required baseline ships in tasks 13 and 14: focus rings, alt text, 4.5:1 contrast, full keyboard operation, and the reduced-motion path. This task covers anything past that
    - Full WCAG validation needs manual testing with assistive technologies and expert review, which is outside what a code task can assert
    - _Requirements: 9.5, 9.6, 9.7_

## Notes

- **Language is TypeScript throughout**, including the ingest script (`tsx`) and the verification script. No decision pending.
- **The `*` convention is inverted for Tier 1 properties.** Design guidance marks test sub-tasks optional by default, but properties 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 25, and 31 are unmarked and required. Those are the ones where a failure means exposed media, escalated privilege, or leaked identity. Tier 2 properties and supplementary example tests carry `*` and can be skipped for the handoff.
- **Task 8 is the early security gate.** After the gate, Media_API, Access_API, and the header set exist, the site deploys and a partial verification runs. Everything after that builds on a foundation already proven against a live URL rather than a local build.
- **Tasks 18.1–18.3 are the definition of done.** Requirement 14.1 states plainly that a successful local build is insufficient evidence. Local `netlify dev` uses a sandboxed blob store and cannot see production data, so the deployed run is the only evidence that counts.
- **The `MAX_VIDEO_BYTES` fallback is a contingency inside task 15.4**, not a separate task. If the 18 MB response fails on the free tier, drop to 5 MB and re-encode. No new service, no blocked ship.
- Optional and clearly deferrable: Tier 2 property tests, supplementary example tests (13.8), the rate-limit key sweep (12.3), chromatic fringe and xerox polish (14.7), and accessibility work beyond the required baseline (20.1).
- Nothing in the design's "Out of Scope for v1" section has a task: no attendee accounts, no admin upload UI, no scheduled auto-purge, no consent-QR system beyond the reserved `MediaEntry.subjects` field and the gate's predicate list, no analytics, no public media URLs, no multi-event support.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0,  "tasks": ["1.1"] },
    { "id": 1,  "tasks": ["1.2", "1.3", "1.4", "1.5"] },
    { "id": 2,  "tasks": ["2.1"] },
    { "id": 3,  "tasks": ["2.2", "3.1"] },
    { "id": 4,  "tasks": ["2.3", "2.4", "3.2"] },
    { "id": 5,  "tasks": ["2.5", "4.1"] },
    { "id": 6,  "tasks": ["4.2", "4.3", "5.1", "6.1", "6.2"] },
    { "id": 7,  "tasks": ["5.2", "6.3"] },
    { "id": 8,  "tasks": ["5.3", "6.4", "7.1"] },
    { "id": 9,  "tasks": ["6.5", "6.6", "6.7", "6.8", "6.9", "7.2", "7.3"] },
    { "id": 10, "tasks": ["7.4", "7.5", "8.1"] },
    { "id": 11, "tasks": ["8.2"] },
    { "id": 12, "tasks": ["10.1", "11.1"] },
    { "id": 13, "tasks": ["10.2", "10.3", "11.2", "11.3", "11.4", "11.5", "11.6"] },
    { "id": 14, "tasks": ["11.7", "11.8", "11.9", "11.10", "11.11", "11.12", "11.13", "11.14", "12.1"] },
    { "id": 15, "tasks": ["12.2", "12.3", "13.1", "13.2", "13.3"] },
    { "id": 16, "tasks": ["13.4", "13.5", "14.1"] },
    { "id": 17, "tasks": ["13.6", "13.7", "13.8", "13.9", "14.2"] },
    { "id": 18, "tasks": ["14.3"] },
    { "id": 19, "tasks": ["14.4"] },
    { "id": 20, "tasks": ["14.5", "14.6", "14.7", "15.1"] },
    { "id": 21, "tasks": ["15.2", "15.3", "15.4", "15.5"] },
    { "id": 22, "tasks": ["15.6", "15.7", "15.8", "15.9", "15.10", "15.11", "15.12", "16.1"] },
    { "id": 23, "tasks": ["16.2"] },
    { "id": 24, "tasks": ["18.1"] },
    { "id": 25, "tasks": ["18.2"] },
    { "id": 26, "tasks": ["18.3"] },
    { "id": 27, "tasks": ["18.4", "20.1"] }
  ]
}
```
