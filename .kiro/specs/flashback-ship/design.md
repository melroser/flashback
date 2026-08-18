# Design Document

## Overview

This is a release-readiness design. The product is built; the evidence that it works
is not assembled. The design below fixes the verification tooling, deploys work
already written, and closes the gap between what the repository claims and what it
does.

One organizing principle: **every claim in this repository should be mechanically
checkable, and every mechanical check should actually run.** The current state
violates that in both directions — there are claims with no check (the 16 mandatory
property tests), and checks that cannot run (lint, e2e, unit).

## Audit Findings

Gathered 2026-08-17 against the Working_Tree at `ba630b3` and the Deployed_Site.
Each finding below is the justification for a requirement, and each was confirmed by
direct observation rather than inference.

### What is genuinely strong

Worth stating first, because the defect list below is long and the product is not
in bad shape.

| Area | Evidence |
|---|---|
| Authorization design | `GateProof` is a branded type constructible only inside `lib/auth/gate.ts`. Bypassing the gate is a compile error, not a review comment. |
| Structural enforcement | `scripts/check-invariants.sh` passes 4/4 and is dependency-free. |
| Contract coverage | `scripts/verify-deployed.ts` carries 43 named assertions, each tagged with the product requirement it validates, run against the deployed site with plain `fetch`. |
| Browser test design | The three real spec files test real clicks and real form submissions, and assert `naturalWidth > 0` so a passing image test means bytes decoded. Written in direct response to a bug class `curl` structurally cannot catch. |
| Build health | `npm run build` exits 0. 19 routes compile. Middleware is 36.8 kB. |
| Gate holding in production | `/api/media/<random-id>` and `/api/grid` both return 401 unauthenticated. `/archive` returns 307. |
| Documentation quality | The README is unusually honest, including two named tradeoffs and a real failure mode most projects would omit. |

### Finding 1: A written fix for a live-site bug is undeployed

`lib/auth/organizer.ts` in the Working_Tree treats the literal string `Origin: null`
as an absent origin rather than a mismatch. Its comment states the consequence of
not doing so: *every* admin button returns FORBIDDEN in Chrome, because
`Referrer-Policy: no-referrer` (required by FB-12.3) causes Chrome to send
`Origin: null` on a same-origin form navigation.

This change is uncommitted. Probing the Deployed_Site confirms it is not live:

```
POST /api/admin/session   Accept: text/html   secret=<wrong>
→ HTTP/2 401
→ {"error":"UNAUTHORIZED"}
```

The Working_Tree version returns `303 → /admin?denied=1` for an HTML request. The
deployed version returns raw JSON, which is the pre-fix behavior.

Additionally: 2 commits (`7fb367f`, `ba630b3`) are unpushed, and 6 tracked files
carry uncommitted modifications. Last production deploy was `2026-08-17T06:31:08Z`.

**Severity: this is the ship blocker.** The Organizer's entire interaction with this
product is the admin page, the kill switch is on that page, and the audit could not
confirm the page is operable in Chrome on the live site. Note that the Chrome
behavior itself is a claim made by the code comment — the audit verified that the fix
is absent from production, not that Chrome fails without it. The fix is a 3-line
change with sound reasoning; the cost of deploying it is far below the cost of the
Organizer finding out.

### Finding 2: `npm test` runs zero tests and exits 1

```
$ npm test
Test Files  4 failed (4)
     Tests  no tests
exit code: 1
```

Three compounding causes:

1. There is no `vitest.config.ts`.
2. Vitest's default include glob is `**/*.{test,spec}.?(c|m)[jt]s?(x)`, which matches
   the four Playwright files in `tests/e2e/`.
3. `tests/e2e/helpers.ts` throws at module scope when `FB_CODE` / `FB_SECRET` are
   unset, so all four fail at collection.

So `npm test` fails for a reason with no relationship to product behavior, and would
keep failing if the product were perfect. It is worse than a missing command, because
it looks like a signal.

`tests/fakes/` exists and is **empty**. The Fake_Blob_Store from task 1.4 — the
foundation every property test depends on — was never built. `fast-check` is
installed and imported by zero modules.

### Finding 3: The documented browser-test command does not exist

The README instructs `npm run e2e` in two places. `package.json` defines:

```
dev, build, start, lint, test, ingest, verify, snapshot-ids, sweep-orphans, reset-archive
```

No `e2e`. Separately, the installed Playwright browser cache contains
`chromium-1071`, `chromium-1194`, and `ffmpeg-1009` — **no `webkit`**. The README
says WebKit "is the one that matters — it is Safari's engine, where that bug lived."
The browser identified as most important cannot currently run.

`tests/e2e/_debug.spec.ts` is untracked, self-describes as "TEMPORARY diagnostic.
Delete after use," logs cookie attributes to stdout, and ends in
`expect(true).toBe(true)`. It sits inside `testDir`, so it would execute on all three
browser projects as part of any suite run.

`playwright.local.config.ts` is untracked and instructs the reader to delete it once
the work is verified.

### Finding 4: The lint invariants never execute

```
$ npm run lint
⨯ ESLint must be installed: npm install --save-dev eslint
```

`eslint` is absent from `devDependencies` and from `node_modules/.bin`.
`eslint.config.mjs` is well-written flat config carrying the `no-restricted-imports`
rules for the media store and `next/image`, with a comment stating the intent
plainly: *"This makes the invariant fail the build instead of relying on a reviewer
noticing."* It has never run. The `lint` script also invokes `next lint`, deprecated
in 15 and removed in 16.

The grep-based `check-invariants.sh` does cover the same two rules and does pass,
which is why this is a P1 rather than a P0 — the guarantee holds, but through the
weaker of the two mechanisms, and the stronger one is silently dead.

### Finding 5: Zero of 16 mandatory property tests exist

`.kiro/specs/flashback/tasks.md` is explicit: properties 1, 2, 4, 5, 6, 7, 8, 9, 10,
11, 12, 14, 15, 18, 25, and 31 are *unmarked and required*, because "a failure in any
of those means exposed media, escalated privilege, or leaked identity." None are
implemented.

This is the largest genuine gap. The Contract_Suite's 43 checks and the
Browser_Suite's 21 tests cover the *example* space well. Neither covers the
*generated* space — the gate's decision table is a cross product of session kind ×
archive state × expiration × item state × variant, and it is currently sampled at a
handful of points.

### Finding 6: tasks.md is entirely unchecked

Every task in `.kiro/specs/flashback/tasks.md` is `- [ ]`, including tasks whose
output is demonstrably present and deployed. The file cannot be used to determine
remaining work, which is the reason this spec exists as a separate document.

### Finding 7: Dead components, and a fix applied to one

`components/PhotoGrid.tsx` (8.3 kB) and `components/GridOverlay.tsx` (8.0 kB) have no
importers. `app/archive/page.tsx` imports `PhotoGridClient`.

This matters beyond tidiness: the uncommitted removal-dialog copy fix — retitling the
dialog from "Take QLK 062 down" to "Take image down", and softening a note
placeholder that read as a request for the person to describe where they are in the
frame — was applied to **both** `GridOverlay.tsx` (dead) and `PhotoGridClient.tsx`
(live). Half that edit ships nothing. The change itself is a real privacy
improvement and should land in the live component only.

### Finding 8: One unexplained 502, not reproducible

The first request of the audit returned 502 on `/` and `/admin`, while
`/api/media/*` and `/api/grid` correctly returned 401 in the same batch. A follow-up
of 12 sequential request pairs returned 200 on both paths every time, with root
latency 0.32–0.79 s and admin 0.10–0.12 s.

Most likely a cold function boot. Recorded rather than diagnosed, because one
unreproducible event on a page that is the Organizer's only entry point is worth
watching and is not worth blocking on.

## Architecture

No runtime architecture changes. The changes are confined to test tooling,
`package.json`, configuration files, and deleting dead code.

```
┌──────────────────────────────────────────────────────────────┐
│                       RELEASE GATE                           │
│                                                              │
│  Offline, no secrets, no network                             │
│  ┌────────────────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ check-invariants.sh│→ │  lint    │→ │   Unit_Suite     │  │
│  │  4 grep assertions │  │  eslint  │  │ vitest+fast-check│  │
│  └────────────────────┘  └──────────┘  └──────────────────┘  │
│           │                                    │             │
│           │                          ┌─────────▼──────────┐  │
│           │                          │  Fake_Blob_Store   │  │
│           │                          │  + read recorder   │  │
│           │                          │  + eventual mode   │  │
│           │                          └────────────────────┘  │
│  ┌────────▼───────────┐                                      │
│  │   npm run build    │                                      │
│  └────────┬───────────┘                                      │
│           │                                                  │
│  ═════════╪══ deploy parity checked here ══════════════════   │
│           │                                                  │
│  Against the DEPLOYED site, mutates the live archive          │
│  ┌────────▼───────────┐        ┌──────────────────────────┐  │
│  │  Contract_Suite    │───────→│      Browser_Suite       │  │
│  │  43 fetch checks   │        │  21 tests × webkit /     │  │
│  │  verify-deployed   │        │  chromium / mobile-safari│  │
│  └────────────────────┘        └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

The dividing line matters. Everything above it runs with no secrets and no network,
so it can run on every save. Everything below it needs `FB_CODE`, `FB_SECRET`, and a
deployed site, and mutates the shared production archive.

## Components and Interfaces

### `vitest.config.ts`

New file. The single change that makes `npm test` meaningful.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/props/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', '.next/**', '.netlify/**'],
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
```

Two decisions worth naming. `include` is an explicit allowlist rather than a broad
glob with exclusions, because the failure being fixed was a glob reaching further
than intended. And `passWithNoTests: false` satisfies Requirement 2.6 — an empty
suite must never read as a pass, which is precisely the trap this repository already
fell into once.

Playwright specs keep the `.spec.ts` suffix; Vitest tests take `.test.ts`. The suffix
split is a second, independent line of defense behind the directory split.

### `tests/fakes/FakeBlobStore.ts`

New file. Bound to the narrow surface the app actually uses, not the full Netlify
Blobs API.

```ts
type Consistency = 'strong' | 'eventual';

interface FakeStoreOptions {
  consistency?: Consistency;
  /** ms to delay write visibility in eventual mode */
  lag?: number;
}

class FakeBlobStore {
  get(key: string, opts?: { type?: 'text' | 'json' | 'stream' | 'arrayBuffer' }): Promise<unknown>;
  getWithMetadata(key: string): Promise<{ data: unknown; metadata: Record<string, unknown> } | null>;
  set(key: string, value: unknown, opts?: { metadata?: Record<string, unknown> }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ blobs: Array<{ key: string }> }>;

  /** Every key read, in order. The assertion surface for Property 1. */
  readonly reads: readonly string[];
  /** Reads whose key matches `media/`. Must be empty on any gate denial. */
  mediaByteReads(): readonly string[];
  resetReads(): void;
}
```

`mediaByteReads()` is the mechanism for Requirement 5.3 and 5.5. Property 1 asserts
not merely that a denial returns the right status, but that **no media byte was ever
fetched** — the difference between "we didn't send it" and "we never read it." Under
`eventual` mode, a `set` becomes visible only after `lag`, which is how Property 2
distinguishes a genuinely strong read from an accidentally-passing one.

### `package.json` script changes

```jsonc
{
  "lint": "eslint .",                                    // was: next lint (deprecated, and eslint absent)
  "test": "vitest --run",                                // unchanged, now meaningful via vitest.config.ts
  "e2e": "playwright test",                              // NEW — README already documents it
  "e2e:local": "playwright test -c playwright.local.config.ts",  // NEW
  "e2e:install": "playwright install webkit chromium",    // NEW — Requirement 3.3
  "gate": "..."                                          // NEW — Requirement 8
}
```

New devDependencies: `eslint@9`, and whatever `eslint.config.mjs` needs to resolve
under flat config. Pin exact versions, consistent with the existing manifest, which
pins everything except `@playwright/test`.

### `scripts/release-gate.sh`

New file implementing Requirement 8. Ordered, fail-fast, and it checks deploy parity
*before* touching the deployed site, so a green run cannot be reported against a site
that does not match the committed tree.

```
1. git: no uncommitted changes under app/ components/ lib/ middleware.ts   (R1.1)
2. git: no unpushed commits on the current branch                          (R1.2)
3. ./scripts/check-invariants.sh                                           (R4.6)
4. npm run lint                                                            (R4.2)
5. npm test                                                                (R2.3)
6. npm run build                                                           (R8.2)
7. playwright engine presence check, clear message if missing              (R3.3)
8. npm run verify -- --url $URL --code $FB_CODE --secret $FB_SECRET        (R8.2)
9. npm run e2e                                                             (R8.2)
```

Steps 1–6 need no secrets. Steps 8–9 mutate the live archive, which the script states
on stdout before running them.

## Data Models

No changes. No blob document schema, no session payload, and no media variant is
touched by this spec.

## Error Handling

### The unit suite must fail for product reasons only

The current failure mode — a test command that fails because of a missing environment
variable in an unrelated directory — is the specific thing being designed out.
Requirement 2.5 states the Unit_Suite needs no network, no deployed site, and no
secrets. The `include` allowlist plus the `.test.ts` / `.spec.ts` suffix split
enforce it structurally rather than by convention.

### Engine-absence must be legible

Playwright's native error when an engine is missing is a wall of text ending in an
install command. Requirement 3.3 asks for a clear message instead, because the
audit's own experience was that WebKit's absence was invisible until explicitly
checked. The gate script checks the engine cache and names the missing engine and the
exact command to install it.

### The gate must not report success against the wrong artifact

Requirement 8.4 puts the parity checks first. Without that ordering, a green
Contract_Suite run proves something about a deployment that may predate the fix under
test — which is the exact shape of the situation this spec was written to resolve.

## Testing Strategy

### Layering

| Layer | Runs against | Needs secrets | Covers |
|---|---|---|---|
| Invariant_Check | Source text | No | Import boundaries, no media under `public/` |
| lint | Source AST | No | Restricted imports, `next/image` ban |
| Unit_Suite | In-process + Fake_Blob_Store | No | Gate decision table, tokens, Range math, removal allowlist, secret non-disclosure |
| Contract_Suite | Deployed site | Yes | 43 HTTP-level requirement assertions |
| Browser_Suite | Deployed site, 3 engines | Yes | Real clicks, real form posts, image decode |

Each layer catches a class the layer above structurally cannot. That is the argument
for adding the Unit_Suite rather than treating 43 contract checks plus 21 browser
tests as sufficient: neither can enumerate a cross product, and the gate's
correctness *is* a cross product.

### Property test priority

All 16 Tier_1 properties are required by the product spec. Not all are equally urgent
for a handoff. Implement in this order, and note that the first five close the
majority of the risk:

1. **Property 1** — the gate decision table, with zero-byte-read assertions. This is
   the single highest-value test in the project.
2. **Property 14** — removal record field allowlisting. Directly protects the
   identity guarantee; a regression here silently starts storing IPs.
3. **Property 6** — privilege separation, with byte-identical state assertions.
4. **Property 4** — token verification outcome table.
5. **Property 31** — secrets absent from responses and bundles.
6. **Property 7** — the Origin check, including the absent and `null` cases. This one
   also becomes the regression test for Finding 1, which is why it is raised above
   its nominal tier position.
7. **Property 15**, **18**, **2**, **8**, **5**, **12**, then the remainder.

### Property 7 as the regression test for the ship blocker

Worth calling out as a design decision. The Chrome `Origin: null` bug has now
occurred twice in this codebase in two shapes: first an absent `Origin` (Safari), then
the literal `null` (Chrome under `no-referrer`). Both times the symptom was every
admin button returning FORBIDDEN, and both times the `fetch`-based Contract_Suite
passed because a `fetch` client sends an `Origin` a browser form does not.

A generated test over `{absent, "null", exact match, trailing slash, case variant,
different host, different scheme, different port}` pins all of it in one place, cheaply
and offline. That is strictly better than relying on a browser suite that requires
secrets and a deployment to tell you the admin page is broken.

## Correctness Properties

Properties 35–38 concern the verification tooling and are new to this spec. Every one
of them is currently **false**, which is why this spec exists.

Properties 1–31 are the Tier_1 subset already defined in
`.kiro/specs/flashback/design.md`, restated here with the generator sketch and the
Fake_Blob_Store hook each one needs. Their substance is unchanged, with Property 7 as
the single deliberate exception. `Validates` lines cite **this** spec's requirement
numbers; the product requirements each property ultimately serves are named in the
property text.

### Property 35: A green test command implies executed assertions

*For any* invocation of `npm test`, an exit code of 0 implies at least one test case was
collected and every collected case passed; and an invocation collecting zero test files
exits non-zero.

**Validates: Requirements 2.3, 2.4, 2.6**

### Property 36: The unit suite is hermetic

*For any* invocation of `npm test` with no network interface, no `FB_CODE`, no
`FB_SECRET`, and no reachable deployed site, the result is identical to an invocation
with all of them available.

**Validates: Requirements 2.2, 2.5**

### Property 37: Every documented command is executable

*For any* command string the README presents as runnable, that string resolves either to
a script defined in `package.json` or to a path that exists in the repository.

**Validates: Requirements 3.9, 7.4**

### Property 38: A gate pass implies deploy parity

*For any* successful Release_Gate run, the Working_Tree carried no uncommitted
modifications under `app/`, `components/`, `lib/`, or `middleware.ts`, and no unpushed
commits, at the moment the deployed-site steps began.

**Validates: Requirements 1.1, 1.2, 8.4**

### Property 1: The gate decides every protected entry point

*For any* combination of session kind (none, attendee, organizer, signature-invalid,
expired, stale code version), archive state, expiration position (past, future), item
state (missing, visible, hidden, deleted), and variant (full, thumb, poster), the gate
returns the status dictated by the ordered chain session → archive state → expiration →
existence → visibility, and `mediaByteReads()` is empty on every denial. Serves product
requirements 2.2 through 2.7, 5.8, 6.4, 8.3, and 11.6.

**Validates: Requirements 5.4, 5.5**

### Property 2: Safety state is never read stale

*For any* write to the archive configuration or to a Media_Item's visibility document
followed immediately by a gate evaluation, with the Fake_Blob_Store in `eventual` mode,
the gate observes the written value. Serves product requirement 2.11.

**Validates: Requirements 5.6**

### Property 4: Session tokens are well-formed, and anything else is no session

*For any* cookie value not produced by minting under the current signing key — absent,
malformed, wrong prefix, wrong segment count, tampered payload, tampered signature, past
expiry, or role swapped between cookie slots — verification treats the request as
carrying no session, with no outcome distinguishable between failure modes. Serves
product requirements 1.4, 7.4, 7.8, and 7.9.

**Validates: Requirements 5.7**

### Property 5: Rotation replaces the code and invalidates prior attendee sessions

*For any* rotation, the new code authenticates, the previous code does not, and every
attendee token carrying the pre-rotation code version is treated as carrying no session,
while organizer tokens carrying code version 0 remain valid. Serves product requirements
6.6 and 6.7.

**Validates: Requirements 5.12**

### Property 6: Organizer privileges come only from an organizer session

*For any* state-changing Admin_API operation attempted with no session or with only an
attendee session, the response is 401 or 403 respectively and the serialized blob state
is byte-identical before and after the request. Serves product requirements 7.1 through
7.3, 7.5, and 7.6.

**Validates: Requirements 5.8**

### Property 7: Cross-origin state change is refused, and same-origin is not

*For any* state-changing Admin_API request carrying a valid organizer session and an
`Origin` header that is absent, the literal string `null`, an exact match, a match
differing only by trailing slash, or a match differing only by letter case, the request
proceeds and its state change is applied; and *for any* such request whose `Origin`
differs in host, scheme, or port, the response is 403 and the persisted state is
byte-identical before and after. Serves product requirement 7.7.

This deliberately widens the original Property 7, which required 403 on an absent
`Origin`. That reading was implemented, shipped, and broke every admin control in
Safari; the narrow form was then reintroduced through `Origin: null` in Chrome under
`Referrer-Policy: no-referrer`. The header is defence in depth behind `SameSite=Strict`,
which is the primary guard, so an absent or opaque origin is treated as no evidence
either way rather than as a mismatch.

**Validates: Requirements 1.4, 5.16**

### Property 8: Range responses return exactly the bytes they describe

*For any* stored object of length N from 1 byte to 18 MB and *any* `Range` header form —
valid, suffix, open-ended, inverted, past-end, zero-length, or a non-`bytes` unit — the
response body length equals the span its `Content-Range` header declares, or the
response is 416 with an empty body and `Content-Range: bytes */N`. Serves product
requirements 3.1 and 3.2.

**Validates: Requirements 5.11**

### Property 9: Every response carries the full security header set

*For any* route in the route table and *any* session state, the response carries
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a
`Permissions-Policy` denying camera, microphone, and geolocation,
`Strict-Transport-Security` with `max-age` at least 31536000,
`X-Robots-Tag: noindex, nofollow`, and a CSP restricting `default-src` to the site
origin with `frame-ancestors 'none'`. Serves product requirements 11.3, 11.4, and 12.1
through 12.5.

**Validates: Requirements 5.19**

### Property 10: Protected responses are never cacheable and always vary on cookie

*For any* Media_API byte response, the response carries the `private` directive, omits
`public` and every shared-cache directive, and sets `Vary: Cookie`; and *for any*
authenticated HTML response, the response carries `Cache-Control: private, no-store`.
Serves product requirements 2.8, 12.6, 12.8, and 12.9.

**Validates: Requirements 5.20**

### Property 11: Media identifiers are opaque and unique

*For any* batch of Media_IDs generated by the Ingest_Script, all identifiers are
distinct, each encodes at least 128 bits of randomness, and no identifier contains any
substring of its source filename, its extension, its modification date in any common
format, or its ordinal position. Serves product requirement 2.9.

**Validates: Requirements 5.21**

### Property 12: Rendered output leaks no source identity

*For any* media index of 0 to 60 entries carrying adversarial original filenames —
embedded personal names, dates, GPS strings, unicode, path separators — the rendered
markup and every JSON payload it embeds contain none of those substrings; and the
unauthenticated Access_Screen response contains zero Media_ID values and zero `data:`
URIs. Serves product requirements 1.2, 2.10, and 2.15.

**Validates: Requirements 5.13**

### Property 14: Removal records contain exactly the allowlisted fields

*For any* removal payload containing arbitrary additional keys, prototype-pollution
shapes, or an oversized note, and *any* request header set carrying client IP and user
agent values, the stored record's key set equals exactly {`schema`, `recordId`,
`mediaId`, `submittedAt`, `status`} together with `note` only when one was supplied, and
no stored value equals or contains any request-derived identifier. Serves product
requirements 5.2, 5.3, 5.5, 5.6, 11.1, and 15.2.

**Validates: Requirements 5.9**

### Property 15: A removal request hides before it responds

*For any* accepted removal request, the referenced Media_Item's hidden flag is already
true at the moment the response is emitted, and a gate evaluation for that Media_Item
issued immediately after the response returns 404 with zero media bytes. Serves product
requirements 5.4 and 5.7.

**Validates: Requirements 5.10**

### Property 18: Deletion is confirmed, scoped, and complete

*For any* delete request whose confirmation string does not exactly match the
server-computed expected value, zero bytes are removed and zero visibility documents
change; and *for any* correctly confirmed delete, every variant of exactly the targeted
items is removed and every other item's bytes and visibility are unchanged. Serves
product requirements 6.11 through 6.13.

**Validates: Requirements 5.15**

### Property 25: Derivatives carry no embedded metadata

*For any* source image with injected EXIF, GPS, IPTC, `XMP-mwg-rs` face regions, or
MakerNotes, the written derivative's tag set is a subset of the fixed allowlist, and a
derivative that fails verification is not written. Serves product requirement 4.3.

**Validates: Requirements 5.22**

### Property 31: Secrets never appear in output

*For any* route response body, *any* asset in the built client bundle, and *any* value
written to the Blob_Store, the content contains neither the Organizer_Secret, the
session signing key, the Attendee_Code plaintext, its hash, nor its salt. Serves product
requirements 1.10 and 13.6.

**Validates: Requirements 5.14**

## Sequencing and Rationale

Four phases. The ordering optimizes for *the Organizer can use the product* first,
*the evidence is trustworthy* second.

**Phase 1 — Unblock the handoff.** Make the browser suite runnable (add the `e2e`
script, install WebKit, delete the scratch spec), land the Chrome fix in the live
component only, commit, push, deploy, then run the Contract_Suite and Browser_Suite
against the deployed site. Phase 1 is what converts "probably works" into "verified in
three engines."

The harness fixes come before the deploy on purpose, and they cost minutes. Deploying
first and verifying after is how the current situation arose.

**Phase 2 — Make the test commands honest.** `vitest.config.ts`, ESLint installed and
running, the Fake_Blob_Store built. No new assertions yet; this phase is purely about
commands that do what their names say.

**Phase 3 — Property coverage.** The 16 Tier_1 properties, in the priority order
above. This is the bulk of the remaining work and the part that can proceed after the
Organizer already has a working archive.

**Phase 4 — Truth and hygiene.** Delete dead components, reconcile `tasks.md`, correct
the README, remove the temporary Playwright config, wire up the gate script.

Phases 3 and 4 do not block the handoff. Phase 1 does, entirely.

## Out of Scope

- Any change to the gate's ordering, predicates, or `GateProof` construction.
- Any change to the privacy posture, the removal flow's field allowlist, or the
  metadata-stripping pipeline.
- The three remaining `sharp` / `postcss` advisories inside Next's vendored tree. The
  README's analysis is sound: both are unreachable given `images: { unoptimized: true }`
  plus the `next/image` ban, and the only offered fix is a breaking major. Revisit
  when a 15.x patch lands.
- Multi-event support, attendee accounts, scheduled auto-purge, the consent-QR
  system, and everything else in the product spec's "Deliberately not built."
- Diagnosing the single 502 beyond recording it and adding a watch item.
