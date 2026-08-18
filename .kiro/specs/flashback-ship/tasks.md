# Implementation Plan: FLASHBACK Ship

## Overview

Four phases, ordered so the Organizer gets a working product first and the evidence
gets trustworthy second.

**Phase 1 blocks the handoff. Phases 2 through 4 do not.** If you only do one thing,
do Phase 1 — it is roughly an hour and it ends with a verified deployment.

Test tasks marked `*` are optional. Everything in Phase 1 is unmarked and required.

A note on ordering inside Phase 1: the test-harness fixes (1.1, 1.2) come *before* the
deploy (1.4) on purpose. They cost minutes, and deploying first and verifying after is
exactly how the current undeployed-fix situation arose.

## Tasks

- [ ] 1. Phase 1 — Unblock the handoff

  - [x] 1.1 Add the missing Playwright scripts and delete the scratch spec
    - Add to `package.json`: `"e2e": "playwright test"`, `"e2e:local": "playwright test -c playwright.local.config.ts"`, `"e2e:install": "playwright install webkit chromium"`
    - `npm run e2e` is documented twice in the README and does not exist; this is the entire browser-test entry point
    - Delete `tests/e2e/_debug.spec.ts`. It self-describes as temporary, logs cookie attributes to stdout, ends in `expect(true).toBe(true)`, and sits inside `testDir` so it runs on all three browser projects
    - _Requirements: 3.1, 3.2, 3.5, 3.6_

  - [ ] 1.2 Add a browserless Origin verification probe
    - **Superseded decision**: the WebKit engine install stalled at extraction twice and is abandoned by explicit user direction. The Playwright browser cache has been deleted. `tests/e2e/` is retained but cannot run until engines are reinstalled, which is now a documented gap rather than a ship step
    - The Chrome bug is that Chrome sends `Origin: null` under `Referrer-Policy: no-referrer`. A browser is required to *discover* that; it is not required to *test* it. Any client can set the header
    - Add `scripts/verify-origin.ts` (invoked by a `verify:origin` script) that signs in as organizer with `FB_SECRET`, then issues a state-changing admin POST for each of `Origin` absent, `Origin: null`, exact origin, trailing-slash origin, and a foreign origin
    - Assert: absent, `null`, exact, and trailing-slash all proceed; the foreign origin returns 403. Non-zero exit on any deviation
    - This is the ship-gating check for the fix in task 1.3, and it replaces the browser suite for that purpose only
    - _Requirements: 3.3, 3.4, 1.4, 6.2, 6.6_

  - [x] 1.3 Land the Chrome `Origin: null` fix in the live component only
    - `lib/auth/organizer.ts` and `app/api/admin/session/route.ts` already carry the correct changes in the working tree — keep them as written
    - `middleware.ts` already carries the `denied` / `expired` reason plumbing — keep as written
    - Apply the removal-dialog copy change (drop the `QLK NNN` reference label from the heading, replace the note placeholder that read as a request to describe your position in the frame) to `components/PhotoGridClient.tsx` **only**. The identical edit currently sitting in `components/GridOverlay.tsx` ships nothing, because no module imports that file
    - Do not alter the gate ordering, the predicates, or `GateProof` construction
    - _Requirements: 1.4, 1.5, 1.6, 7.2_

  - [ ] 1.4 Commit, push, and deploy
    - Commit the working-tree changes and push the two unpushed commits (`7fb367f`, `ba630b3`) so `origin/master` matches local
    - Deploy to production with `netlify deploy --build --prod`
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ] 1.5 Verify the fix against the deployed site
    - Confirm `POST /api/admin/session` with a wrong secret and `Accept: text/html` returns `303 → /admin?denied=1`, and that the same request without `text/html` still returns `401 {"error":"UNAUTHORIZED"}` so the contract assertions hold
    - Run `npm run verify -- --url <url> --code <code> --secret <secret>` and confirm all 43 checks pass
    - Run `npm run verify:origin` from task 1.2 and confirm every Origin form behaves correctly against the deployed site
    - The browser suite is NOT part of this gate; engines are uninstalled. Record that as a known gap
    - `verify` mutates the live archive. If interrupted, use `/admin` → **Restore everything hidden**, then **Dismiss all**
    - _Requirements: 1.7, 3.7, 3.8, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [ ] 2. Checkpoint — the Organizer can use the product
  - The deployed site is operable in WebKit, Chromium, and mobile Safari, confirmed by real clicks. Handoff is unblocked here. Ask the user whether to continue into Phase 2 now or hand off first.

- [ ] 3. Phase 2 — Make the test commands honest

  - [ ] 3.1 Add `vitest.config.ts` and separate the two suites
    - `include: ['tests/unit/**/*.test.ts', 'tests/props/**/*.test.ts']`, `exclude: ['tests/e2e/**', 'node_modules/**', '.next/**', '.netlify/**']`, `environment: 'node'`, `passWithNoTests: false`
    - Use an explicit allowlist rather than a broad glob with exclusions; the defect being fixed is a default glob reaching into `tests/e2e/` and collecting Playwright specs, which throw at module scope because `tests/e2e/helpers.ts` requires `FB_CODE` and `FB_SECRET`
    - `passWithNoTests: false` is deliberate: an empty suite must never read as a pass
    - Keep `.test.ts` for Vitest and `.spec.ts` for Playwright as a second line of defense behind the directory split
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

  - [ ] 3.2 Install ESLint and make the restricted-import rules run
    - Add `eslint` at a version compatible with the existing flat config in `eslint.config.mjs`, pinned exactly, consistent with the rest of the manifest
    - Change the `lint` script from `next lint` to `eslint .`; `next lint` is deprecated in 15 and removed in 16, and currently fails with "ESLint must be installed"
    - Confirm the `no-restricted-imports` rules fire: a media-store import from a disallowed module and a `next/image` import must each exit non-zero. These rules were written to fail the build and have never executed
    - Leave `scripts/check-invariants.sh` untouched and independent, so the structural guarantee survives a lint config error
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ] 3.3 Build the Fake_Blob_Store
    - `tests/fakes/FakeBlobStore.ts` over the narrow surface the app uses: `get`, `getWithMetadata`, `set`, `delete`, `list`. `tests/fakes/` exists and is empty; this is the foundation every property test depends on
    - `eventual` mode delaying write visibility by a configurable lag, so Property 2 can distinguish a genuinely strong read from an accidentally-passing one
    - A read recorder exposing `reads` and `mediaByteReads()`, so Property 1 can assert that a denial read **zero media bytes** rather than merely returning the right status
    - Bind it to the injection seam the two stores in `lib/blobs/` already expose
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ] 3.4 Add a smoke test so the suite is non-empty and hermetic
    - One test under `tests/unit/` exercising the Fake_Blob_Store round trip, to prove `npm test` now collects, runs, and exits 0
    - Confirm the suite runs with no network, no `FB_CODE`, and no `FB_SECRET`
    - _Requirements: 2.2, 2.5, 2.7_

- [ ] 4. Phase 3 — Security-critical property coverage

  Implement in this order. The first five close most of the risk; all sixteen are
  required by the product spec before it calls itself v1.

  - [ ] 4.1 Property 1 — the gate decision table
    - Generate session kind × archive state × expiration position × item state × variant; assert the status the ordered chain dictates
    - Assert `mediaByteReads()` is empty on every denial. This is the highest-value test in the project: it distinguishes "we did not send the bytes" from "we never read them"
    - _Requirements: 5.4, 5.5, 5.17_

  - [ ] 4.2 Property 14 — removal record field allowlisting
    - Generate valid payloads plus arbitrary extra keys, prototype-pollution shapes, and oversized notes, with header sets carrying IPs and user agents
    - Assert the stored key set is exactly the allowlist. A regression here silently starts storing identity
    - _Requirements: 5.9, 5.17_

  - [ ] 4.3 Property 6 — privilege separation
    - Assert 401 and 403 for every state-changing admin route, and that serialized blob state is byte-identical before and after every rejected request
    - _Requirements: 5.8, 5.17_

  - [ ] 4.4 Property 4 — token verification outcome table
    - One generated case per failure mode: absent, malformed, wrong prefix, wrong segment count, tampered payload, tampered signature, expired, role swapped between cookie slots. Assert no distinguishable outcome between them
    - _Requirements: 5.7, 5.17_

  - [ ] 4.5 Property 31 — secrets never appear in output
    - Scan route response bodies, every asset in the built client bundle, and every value written to the store for the organizer secret, the signing key, and the attendee code plaintext, hash, and salt
    - _Requirements: 5.14, 5.17_

  - [ ] 4.6 Property 7 — the Origin check, both directions
    - Generate `Origin` ∈ {absent, `"null"`, exact, trailing slash, case variant} and assert the request proceeds; and ∈ {different host, different scheme, different port} and assert 403 with zero state change
    - This is the regression test for the Phase 1 blocker. The bug has now occurred twice in two shapes — absent `Origin` in Safari, then `Origin: null` in Chrome under `no-referrer` — and both times the `fetch`-based contract suite passed, because a `fetch` client sends an `Origin` a browser form does not. Pin it offline, where it costs nothing to run
    - _Requirements: 1.4, 5.16, 5.17_

  - [ ] 4.7 Property 15 — hide before respond
    - Assert a gate evaluation issued the instant the removal response lands already returns 404
    - _Requirements: 5.10, 5.17_

  - [ ] 4.8 Property 18 — deletion confirmed, scoped, complete
    - Assert zero deletions for every non-matching confirmation string, and exact scoping for a matching one
    - _Requirements: 5.15, 5.17_

  - [ ] 4.9 Property 2 — strong reads
    - Run the gate against the Fake_Blob_Store in `eventual` mode and assert it observes the most recent `config` and `vis` writes
    - _Requirements: 5.6, 5.17_

  - [ ] 4.10 Property 8 — Range responses
    - Generate valid, suffix, open-ended, inverted, past-end, zero-length, and non-`bytes` unit forms against sizes from 1 byte to 18 MB
    - _Requirements: 5.11, 5.17_

  - [ ] 4.11 Property 5 — rotation invalidates prior attendee sessions
    - Assert the new code authenticates, the old does not, pre-rotation attendee tokens are rejected, and organizer tokens at code version 0 survive
    - _Requirements: 5.12, 5.17_

  - [ ] 4.12 Property 12 — no source identity in rendered output
    - Generate indexes of 0–60 entries with adversarial filenames: embedded names, dates, GPS strings, unicode, path separators
    - _Requirements: 5.13, 5.17_

  - [ ] 4.13 Property 9 — the security header set
    - Iterate the route table × session state
    - _Requirements: 5.19, 5.17_

  - [ ] 4.14 Property 10 — cache and Vary behavior
    - Assert `private`, no shared-cache directives, `Vary: Cookie` on media; `private, no-store` on authenticated HTML
    - _Requirements: 5.20, 5.17_

  - [ ] 4.15 Property 11 — Media_ID opacity
    - Assert distinctness, ≥128 bits, and no substring derived from filename, extension, mtime, or ordinal
    - _Requirements: 5.21, 5.17_

  - [ ] 4.16 Property 25 — metadata stripping
    - Generate small synthetic images with injected EXIF, GPS, IPTC, `XMP-mwg-rs` face regions, and MakerNotes; assert the derivative tag set is within the allowlist and that a failing derivative is not written
    - Keep dimensions small so 100 sharp encodes stay fast
    - _Requirements: 5.22, 5.17_

- [ ] 5. Checkpoint — Tier 1 coverage complete
  - All sixteen Tier_1 properties pass offline. Ask the user if questions arise.

- [ ] 6. Phase 4 — Repository truth and the release gate

  - [ ] 6.1 Delete the dead components
    - Remove `components/PhotoGrid.tsx` and `components/GridOverlay.tsx`. Neither has any importer; `app/archive/page.tsx` imports `PhotoGridClient`
    - Confirm the build and the browser suite still pass afterward
    - _Requirements: 7.1_

  - [ ] 6.2 Remove the temporary Playwright config
    - Delete `playwright.local.config.ts` once `e2e:local` covers pre-deploy validation, or commit it with the self-deleting instruction removed from its header. It currently instructs the reader to delete it
    - _Requirements: 7.6_

  - [ ] 6.3 Reconcile `.kiro/specs/flashback/tasks.md` with reality
    - Mark complete every task whose output exists. All tasks are currently `- [ ]` including ones that are built and deployed, which makes the file unusable for determining remaining work
    - Leave the unimplemented Tier_1 property tasks unchecked, and cross-reference this spec's Phase 3 for them
    - _Requirements: 5.18, 7.3_

  - [ ] 6.4 Correct the README
    - `npm run e2e` now exists; confirm every other documented command resolves to a script or an existing path
    - State the Contract_Suite count as 43, or as an explicit approximation
    - Add the engine install step to the browser-test section
    - Decide `scripts/tmp/`: remove it, or document it as scratch excluded from the gate
    - _Requirements: 3.8, 3.9, 7.4, 7.5, 7.7_

  - [ ] 6.5 Add the release gate script
    - `scripts/release-gate.sh` running, in order: uncommitted-change check under `app/ components/ lib/ middleware.ts`, unpushed-commit check, `check-invariants.sh`, `npm run lint`, `npm test`, `npm run build`, engine presence check, `npm run verify`, `npm run e2e`
    - Fail fast on any non-zero exit
    - The parity checks run **first**, before anything touches the deployed site, so a green run cannot be reported against a deployment that does not match the committed tree
    - Print, before the deployed-site steps, which steps mutate the live archive and what an interrupted run can leave behind
    - Add a `gate` script to `package.json`
    - _Requirements: 4.7, 8.1, 8.2, 8.3, 8.4, 8.6, 8.7_

  - [ ] 6.6 Document the gate and the credit failure mode
    - README section listing the gate sequence and the environment variables each step needs, by name only
    - Restate that exhausting the Netlify credit allowance pauses the site regardless of a green gate, so the countdown is not the only clock
    - Note the end-state guarantee: archive `LIVE`, intended expiration, zero attendee-facing items hidden or deleted
    - _Requirements: 8.5, 8.6, 8.7, 8.8_

  - [ ]* 6.7 Add a watch item for the unexplained 502
    - One 502 was observed on `/` and `/admin` during the audit while `/api/*` correctly returned 401 in the same batch; 12 sequential retries then returned 200 on both, root latency 0.32–0.79 s
    - Most likely a cold function boot. Add a periodic check against `/` and record whether it recurs. Do not block the handoff on it
    - _Requirements: 6.1_

## Notes

- **Phase 1 is the ship blocker and nothing else is.** It ends with a deployment
  verified by 43 contract checks and 21 browser tests across three engines.
- **The single most consequential finding**: a written, well-reasoned fix for a bug
  that disables every organizer control in Chrome is sitting uncommitted, and the
  deployed site does not have it. Confirmed by probing the live site, which returns the
  pre-fix raw-JSON 401 rather than the post-fix 303.
- **`npm test` currently exits 1 having run zero tests.** It is worse than a missing
  command because it looks like a signal. Cause is a missing `vitest.config.ts` letting
  Vitest's default glob collect Playwright specs that throw at import.
- **`npm run e2e` does not exist**, and WebKit is not installed. The two facts together
  mean the browser suite — the best-designed part of the verification story — has no
  working entry point and cannot run on the engine that matters.
- **The Origin bug has occurred twice in two shapes.** Property 7 (task 4.6) is
  deliberately widened to pin both, and is raised above its nominal tier position for
  that reason.
- **What is already good, and should not be touched**: the `GateProof` branded type,
  the ordered gate chain, `check-invariants.sh`, the 43 requirement-tagged contract
  assertions, and the browser suite's design. This spec adds evidence around that work
  rather than changing it.
- Nothing in this spec changes the authorization model, the privacy posture, the
  ingest pipeline, or the visual identity.
- The three remaining `sharp` / `postcss` advisories inside Next's vendored tree stay
  as they are. The README's reasoning is sound and the only offered fix is a breaking
  major.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["1.5"] },
    { "id": 4, "tasks": ["3.1", "3.2"] },
    { "id": 5, "tasks": ["3.3"] },
    { "id": 6, "tasks": ["3.4"] },
    { "id": 7, "tasks": ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6"] },
    { "id": 8, "tasks": ["4.7", "4.8", "4.9", "4.10", "4.11", "4.12"] },
    { "id": 9, "tasks": ["4.13", "4.14", "4.15", "4.16"] },
    { "id": 10, "tasks": ["6.1", "6.2", "6.3", "6.4"] },
    { "id": 11, "tasks": ["6.5"] },
    { "id": 12, "tasks": ["6.6", "6.7"] }
  ]
}
```
