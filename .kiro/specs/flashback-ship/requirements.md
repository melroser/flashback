# Requirements Document

## Introduction

FLASHBACK is built, deployed, and serving. This spec covers the distance between
"the code exists" and "this is handed to the Organizer." It is a release-readiness
spec, not a feature spec.

The product requirements live in `.kiro/specs/flashback/requirements.md` and are
unchanged by this document. Requirement references of the form `FB-14.10` point at
that file. Requirements defined here are numbered independently.

### Why this spec exists

An audit of the working tree, the deployed site, and the test tooling on 2026-08-17
found that the product is substantially complete and the *verification story is not
wired up*. Specifically:

- A fix for a bug that disables every organizer control in Chrome is written,
  reasoned about in a code comment, and **sitting uncommitted**. The deployed site
  does not have it.
- `npm test` exits non-zero and runs **zero** tests. It reports failure for a reason
  unrelated to any product behavior.
- `npm run e2e`, documented twice in the README as the browser-test entry point,
  **is not defined** in `package.json`.
- WebKit, which the README identifies as the browser that matters, **is not
  installed**.
- `npm run lint` cannot run because ESLint is **not a dependency**, so the
  `no-restricted-imports` rules written specifically to fail the build do not.
- Zero of the 16 property tests that `.kiro/specs/flashback/tasks.md` declares
  mandatory for v1 exist. `fast-check` is installed and never imported.

Each of these is a gap between a claim and a fact. The product's core promise is
that people depicted in the media are protected, and the evidence for that promise
is currently weaker than the repository presents it as being.

### What is explicitly NOT in scope

No new product features. No changes to the authorization model, the gate ordering,
the privacy posture, the visual identity, or the ingest pipeline. No new runtime
dependencies. No new vendors. This spec adds verification, corrects
documentation-to-reality drift, and deploys work already written.

## Glossary

- **Working_Tree**: The local checked-out state of the repository, including
  uncommitted modifications and untracked files.
- **Deployed_Site**: The live Netlify production deployment at
  `https://flashback-qlick.netlify.app`.
- **Unit_Suite**: The Vitest-run tests that execute without network access and
  without a deployed site, including all property tests.
- **Browser_Suite**: The Playwright-run tests under `tests/e2e/`.
- **Contract_Suite**: The `fetch`-based assertions in `scripts/verify-deployed.ts`.
- **Invariant_Check**: The structural assertions in `scripts/check-invariants.sh`.
- **Tier_1_Property**: One of the 16 property tests that
  `.kiro/specs/flashback/tasks.md` marks required for v1 — properties 1, 2, 4, 5,
  6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 25, and 31. A failure in any of them means
  exposed media, escalated privilege, or leaked identity.
- **Fake_Blob_Store**: The in-memory test double standing in for Netlify Blobs,
  supporting the `get`, `getWithMetadata`, `set`, `delete`, and `list` surface the
  application uses, with an `eventual` mode that delays write visibility.
- **Release_Gate**: The ordered command sequence that must pass before the archive
  is handed to the Organizer.
- **Scratch_Spec**: A test file written as a one-off diagnostic rather than as a
  durable assertion, identifiable by a tautological assertion or a stated intent to
  be deleted.
- **Dead_Component**: A React component module under `components/` that no other
  module imports.

## Requirements

### Requirement 1: Deploy Parity

**User Story:** As the Photographer, I want the deployed site to contain every fix I
have written, so that a bug I already solved is not still breaking things for the
Organizer.

#### Acceptance Criteria

1. THE Working_Tree SHALL contain zero uncommitted modifications to files under
   `app/`, `components/`, `lib/`, and `middleware.ts` at the moment the
   Release_Gate is run.
2. THE Working_Tree SHALL have zero commits that are absent from the `origin/master`
   remote branch at the moment the Release_Gate is run.
3. THE Deployed_Site SHALL serve the code corresponding to the `origin/master` commit
   that the Release_Gate was run against.
4. WHEN a state-changing Admin_API route receives a request carrying the header
   `Origin: null` together with a valid Organizer_Session, THE Deployed_Site SHALL
   process the request rather than responding with HTTP 403.
5. WHEN the Admin_API session route receives an incorrect Organizer_Secret from a
   request whose `Accept` header includes `text/html`, THE Deployed_Site SHALL
   respond with HTTP 303 to `/admin?denied=1` and SHALL NOT respond with a raw JSON
   body.
6. WHEN the Admin_API session route receives an incorrect Organizer_Secret from a
   request whose `Accept` header does not include `text/html`, THE Deployed_Site
   SHALL respond with HTTP 401 and the body `{"error":"UNAUTHORIZED"}`, so that the
   Contract_Suite assertions continue to hold.
7. THE verification of criteria 4 through 6 SHALL be performed against the
   Deployed_Site and SHALL treat a successful local build as insufficient evidence,
   consistent with FB-14.1.

### Requirement 2: A Test Command That Means Something

**User Story:** As the Photographer, I want `npm test` to run the offline suite and
report a truthful exit code, so that a green result is evidence and a red result
points at a real defect.

#### Acceptance Criteria

1. THE repository SHALL contain a Vitest configuration file that restricts test
   collection to the Unit_Suite and excludes every file under `tests/e2e/`.
2. WHEN `npm test` runs with no environment variables set beyond the system
   defaults, THE Unit_Suite SHALL collect and execute without any collection error.
3. WHEN `npm test` runs and every collected test passes, THE command SHALL exit with
   code 0.
4. WHEN `npm test` runs and at least one collected test fails, THE command SHALL
   exit with a non-zero code.
5. THE Unit_Suite SHALL require zero network access, zero deployed site, and zero
   secret values in order to execute.
6. IF the Unit_Suite collects zero test files, THEN THE `npm test` command SHALL
   exit with a non-zero code, so that an empty suite is never reported as a pass.
7. THE Unit_Suite SHALL execute in at most 120 seconds on the Photographer's machine.

### Requirement 3: A Browser Suite That Can Actually Be Run

**User Story:** As the Photographer, I want the documented browser-test command to
exist and to run on the browser where the bugs actually live, so that clicking a real
button is part of my evidence.

#### Acceptance Criteria

1. THE `package.json` SHALL define a script named `e2e` that invokes Playwright with
   the committed `playwright.config.ts`.
2. THE `package.json` SHALL define a script that invokes Playwright against a
   caller-supplied `BASE_URL` for pre-deploy validation.
3. THE repository SHALL document the exact command that installs the browser engines
   the Browser_Suite requires, and THE Release_Gate SHALL fail with a clear message
   if a required engine is absent.
4. THE Browser_Suite SHALL execute against the WebKit engine, the Chromium engine,
   and a mobile Safari device profile, consistent with the committed
   `playwright.config.ts`.
5. THE `tests/e2e/` directory SHALL contain zero Scratch_Specs.
6. THE Browser_Suite SHALL contain zero tautological assertions, where a
   tautological assertion is one that cannot fail as a consequence of any product
   behavior.
7. WHEN the Browser_Suite completes a full run, THE Browser_Suite SHALL leave zero
   Media_Items Hidden and zero Removal_Requests in status `PENDING` that it created.
8. WHERE the Browser_Suite is interrupted before completing, THE repository SHALL
   document the manual recovery steps and the Admin_View controls that perform them.
9. THE every command that the README presents as runnable SHALL be defined in
   `package.json` or SHALL be a path to a file that exists in the repository.

### Requirement 4: Structural Invariants That Fail The Build

**User Story:** As the Photographer, I want the rules that keep media bytes behind
the gate to be enforced mechanically, so that a future edit cannot quietly route
around the authorization boundary.

#### Acceptance Criteria

1. THE repository SHALL declare ESLint as a development dependency at a version
   compatible with the flat configuration in `eslint.config.mjs`.
2. WHEN the lint command runs, THE lint command SHALL evaluate the
   `no-restricted-imports` rules declared in `eslint.config.mjs` and SHALL exit
   non-zero if any is violated.
3. THE lint command SHALL NOT depend on `next lint`, which is deprecated and is
   removed in Next.js 16.
4. WHEN a module other than `lib/media/serve.ts`, `lib/media/purge.ts`, or a module
   under `scripts/ingest/` imports the media blob store, THE lint command SHALL exit
   non-zero.
5. WHEN any module under `app/` or `components/` imports `next/image`, THE lint
   command SHALL exit non-zero.
6. THE Invariant_Check SHALL continue to pass and SHALL remain independent of the
   lint command, so that the structural guarantee survives a lint configuration
   error.
7. THE Release_Gate SHALL invoke both the lint command and the Invariant_Check.

### Requirement 5: Security-Critical Property Coverage

**User Story:** As a person depicted in the media, I want the authorization gate
proven against adversarial inputs rather than a handful of examples, so that the
promise that my photograph is unreachable is backed by evidence.

#### Acceptance Criteria

1. THE repository SHALL provide a Fake_Blob_Store supporting `get`,
   `getWithMetadata`, `set`, `delete`, and `list` over the store surface the
   application uses.
2. THE Fake_Blob_Store SHALL provide an `eventual` mode that delays write
   visibility, so that a strong-consistency requirement can be distinguished from an
   eventually-consistent read.
3. THE Fake_Blob_Store SHALL record every read of a media byte key, so that a test
   can assert that zero media bytes were read on an authorization denial.
4. THE Unit_Suite SHALL assert Tier_1_Property 1, that the gate decides every
   protected entry point, over a generated space of session kind, archive state,
   expiration position, item state, and variant, validating FB-2.2 through FB-2.7,
   FB-5.8, FB-6.4, FB-8.3, and FB-11.6.
5. THE Unit_Suite SHALL assert Tier_1_Property 1 by confirming zero media byte reads
   on every generated denial.
6. THE Unit_Suite SHALL assert Tier_1_Property 2, that safety state is never read
   stale, by running the gate against the Fake_Blob_Store in `eventual` mode,
   validating FB-2.11.
7. THE Unit_Suite SHALL assert Tier_1_Property 4, that a session token is accepted
   only when produced by the current signing key and otherwise treated as no
   session, validating FB-1.4, FB-7.4, FB-7.8, and FB-7.9.
8. THE Unit_Suite SHALL assert Tier_1_Property 6, that organizer privileges derive
   only from an Organizer_Session, and SHALL confirm that persisted state is
   byte-identical before and after every rejected request, validating FB-7.1 through
   FB-7.3, FB-7.5, and FB-7.6.
9. THE Unit_Suite SHALL assert Tier_1_Property 14, that a stored removal record
   contains exactly the allowlisted fields when submitted with arbitrary extra keys,
   prototype-pollution shapes, and request headers carrying IP addresses and user
   agents, validating FB-5.2, FB-5.3, FB-5.5, FB-5.6, FB-11.1, and FB-15.2.
10. THE Unit_Suite SHALL assert Tier_1_Property 15, that a removal request sets the
    Hidden flag before it sends its response, validating FB-5.4 and FB-5.7.
11. THE Unit_Suite SHALL assert Tier_1_Property 8, that a Range response returns
    exactly the bytes its `Content-Range` header describes, over valid, suffix,
    open-ended, inverted, past-end, zero-length, and non-`bytes` unit forms,
    validating FB-3.1 and FB-3.2.
12. THE Unit_Suite SHALL assert Tier_1_Property 5, that code rotation replaces the
    code and invalidates every previously issued Attendee_Session, validating FB-6.6
    and FB-6.7.
13. THE Unit_Suite SHALL assert Tier_1_Property 12, that rendered output leaks no
    source identity, over generated indexes carrying adversarial original filenames,
    validating FB-1.2 and FB-2.10.
14. THE Unit_Suite SHALL assert Tier_1_Property 31, that the Organizer_Secret, the
    session signing key, the Attendee_Code plaintext, its hash, and its salt appear
    in zero route response bodies and zero built client bundle assets, validating
    FB-1.10 and FB-13.6.
15. THE Unit_Suite SHALL assert Tier_1_Property 18, that deletion requires its typed
    confirmation and performs zero blob deletions when that confirmation is absent
    or mismatched, validating FB-6.11 through FB-6.13.
16. THE Unit_Suite SHALL assert Tier_1_Property 7, that a state-changing request
    carrying a mismatched `Origin` header is refused, AND SHALL assert that a request
    carrying an absent `Origin` header or the literal `Origin: null` is permitted,
    validating FB-7.7 and Requirement 1 criterion 4.
17. EACH property assertion SHALL execute at least 100 generated cases by default.
18. WHERE a Tier_1_Property is not yet implemented, THE `.kiro/specs/flashback/tasks.md`
    file SHALL NOT represent it as complete.
19. THE Unit_Suite SHALL assert Tier_1_Property 9, that every response over the route
    table and session-state cross product carries the full security header set,
    validating FB-11.3, FB-11.4, and FB-12.1 through FB-12.5.
20. THE Unit_Suite SHALL assert Tier_1_Property 10, that every media byte response
    carries the `private` directive and `Vary: Cookie` and omits every shared-cache
    directive, and that every authenticated HTML response carries
    `Cache-Control: private, no-store`, validating FB-2.8, FB-12.6, FB-12.8, and
    FB-12.9.
21. THE Unit_Suite SHALL assert Tier_1_Property 11, that every generated Media_ID is
    distinct, carries at least 128 bits of randomness, and contains no substring
    derived from its source filename, extension, modification date, or ordinal
    position, validating FB-2.9.
22. THE Unit_Suite SHALL assert Tier_1_Property 25, that a derivative produced from a
    source carrying injected EXIF, GPS, IPTC, face-region, or MakerNotes metadata has
    a tag set within the fixed allowlist, and that a derivative failing verification
    is not written, validating FB-4.3.

### Requirement 6: Live Organizer Operability

**User Story:** As the Organizer, I want every control on the admin page to work in
the browser I actually use, so that the kill switch is a kill switch and not a
FORBIDDEN page.

#### Acceptance Criteria

1. WHEN the Organizer submits the correct Organizer_Secret through the sign-in form
   on the Deployed_Site, THE Deployed_Site SHALL render the Admin_View with the
   counts specified in FB-6.1.
2. WHEN the Organizer activates the disable control on the Deployed_Site, THE
   Deployed_Site SHALL persist Archive_State `DISABLED` and SHALL NOT render a body
   containing `FORBIDDEN`.
3. WHEN the Organizer activates the enable control on the Deployed_Site, THE
   Deployed_Site SHALL persist Archive_State `LIVE`.
4. WHEN the Organizer activates the hide control and then the restore control on the
   Deployed_Site, THE Deployed_Site SHALL apply both and SHALL NOT render a body
   containing `FORBIDDEN`.
5. WHEN the Organizer activates a delete control on the Deployed_Site without the
   exact typed confirmation, THE Deployed_Site SHALL refuse the operation and SHALL
   delete zero bytes.
6. THE verification of criteria 1 through 5 SHALL be performed by the Browser_Suite
   through real form submissions on the WebKit engine, the Chromium engine, and a
   mobile Safari device profile.
7. THE verification of criteria 1 through 5 SHALL NOT be considered satisfied by the
   Contract_Suite alone, because a `fetch` client sets headers that no browser form
   submission sets.

### Requirement 7: Repository Truth

**User Story:** As the Photographer picking this up in three months, I want the
repository to describe what is actually there, so that I trust it instead of
re-deriving it.

#### Acceptance Criteria

1. THE repository SHALL contain zero Dead_Components.
2. WHERE a behavior fix is applied to a component, THE fix SHALL be applied to the
   component that the application imports.
3. THE `.kiro/specs/flashback/tasks.md` file SHALL mark each task complete if and
   only if the work that task describes exists in the Working_Tree.
4. THE README SHALL document only commands that satisfy Requirement 3 criterion 9.
5. THE README SHALL state the count of assertions in the Contract_Suite accurately,
   or SHALL state it as an approximation explicitly.
6. THE repository SHALL contain zero temporary configuration files whose own
   contents instruct the reader to delete them, at the moment the Release_Gate is
   run.
7. WHERE a script under `scripts/tmp/` exists, THE repository SHALL either remove it
   or document that the directory is scratch and excluded from the Release_Gate.

### Requirement 8: The Release Gate

**User Story:** As the Photographer, I want one documented sequence that tells me
whether this is safe to hand over, so that shipping is a decision I make on evidence
rather than on feel.

#### Acceptance Criteria

1. THE repository SHALL define a single documented command sequence constituting the
   Release_Gate.
2. THE Release_Gate SHALL include, in order: the Invariant_Check, the lint command,
   the Unit_Suite, a production build, the Contract_Suite against the Deployed_Site,
   and the Browser_Suite against the Deployed_Site.
3. THE Release_Gate SHALL fail if any constituent step exits non-zero.
4. THE Release_Gate SHALL verify Requirement 1 criteria 1 and 2 before running any
   step that targets the Deployed_Site, so that the site under test corresponds to
   committed code.
5. WHEN the Release_Gate completes successfully, THE Archive_State SHALL be `LIVE`,
   THE Expiration_Timestamp SHALL hold the value the Organizer intends, and zero
   Media_Items intended for Attendee viewing SHALL be Hidden or Deleted, consistent
   with FB-14.18.
6. THE Release_Gate SHALL be documented with the environment variables each step
   requires, by name only.
7. THE Release_Gate SHALL state which steps mutate the live archive, so that the
   Photographer knows what an interrupted run can leave behind.
8. THE repository SHALL document that exhausting the Netlify Credit_Allowance pauses
   the Deployed_Site regardless of a green Release_Gate, consistent with FB-13.11.
