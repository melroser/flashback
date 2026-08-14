# FLASHBACK

A private, temporary archive of one night. This build serves one event: **QLICK QRAVE**.

Live: https://flashback-qlick.netlify.app

The rave happens → the photographer builds the archive → the organizer reviews it →
the organizer distributes access → attendees revisit the night → anyone depicted can
ask for removal → the archive disappears.

FLASHBACK knows nothing about attendees. No accounts, no names, no emails, no
analytics, no tracking of any kind. One shared access code, which the organizer
distributes through the event's own channel.

---

## Handing it to the organizer

Send four things, out of band. None of them belong in this repo.

| | |
|---|---|
| Attendee URL | `https://flashback-qlick.netlify.app` |
| Attendee code | printed once by `npm run ingest`; rotate in `/admin` to get a new one |
| Organizer URL | `https://flashback-qlick.netlify.app/admin` |
| Organizer secret | value of `FLASHBACK_ORGANIZER_SECRET` |

The organizer sends the attendee URL and code to attendees herself. The photographer
never receives an attendee list, and the app has no mechanism to import or store one.

### The control that matters

`/admin` → **Disable archive**. One click. Attendees can no longer sign in, and
existing sessions stop loading media within about a second. Nothing is deleted, so
**Enable archive** puts it back.

Also in `/admin`: change expiration, rotate the attendee code, hide/restore/delete
individual items, restore everything hidden, delete everything, and review removal
requests.

---

## Commands

```bash
npm run ingest -- <dir> [--dry-run] [--featured <file>] [--mute <file>] [--audio <file>=<track.m4a>]
npm run verify -- --url <url> --code <code> --secret <secret>
npm run build
npm test
./scripts/check-invariants.sh
```

`ingest` runs on the photographer's machine and writes straight to production Blobs.
It never runs on Netlify. Source files are opened read-only and never modified —
**your originals are never touched, and expiry never deletes them.** Archive
visibility and source retention are deliberately different policies.

Always `--dry-run` first. It reports sizes, skips RAW by extension, and verifies
every derivative carries no EXIF, GPS, IPTC, XMP, MakerNotes, or embedded face
regions, without writing anything.

`verify` runs ~30 assertions against the deployed site, including a timed check that
Disable takes hold within 5 seconds. **A green local build is not evidence** —
Netlify Dev uses a sandboxed blob store that cannot see production data.

---

## Environment variables

Set on the Netlify site (`netlify env:set`):

| Name | Required | Purpose |
|---|---|---|
| `FLASHBACK_SESSION_KEY` | yes | HMAC key for session cookies and IP hashing |
| `FLASHBACK_ORGANIZER_SECRET` | yes | Organizer credential. Env only, never written to Blobs |
| `FLASHBACK_EVENT_NAME` | no | Defaults to `QLICK QRAVE` |
| `FLASHBACK_ARCHIVE_ID` | no | Defaults to `qlick-qrave` |
| `FLASHBACK_EXPIRES_AT` | no | ISO seed; otherwise 12 days from creation |
| `FLASHBACK_SITE_ORIGIN` | no | Origin check target; falls back to Netlify's `URL` |
| `FLASHBACK_ATTENDEE_CODE_SEED` | no | Recovery only. Normally unset, because ingest seeds the code |

Ingest-only, in `.env.ingest.local` (gitignored):
`NETLIFY_SITE_ID`, `NETLIFY_API_TOKEN`.

The app refuses to start without a session key or organizer secret. If no attendee
code exists it forces the archive `DISABLED` — no code must never mean no lock.

---

## How the privacy actually works

**Media is never public.** Bytes live in Netlify Blobs, which has no public URLs at
all. Every byte is served by `GET /api/media/[id]` only after an ordered check:
session → archive enabled → not expired → item exists → item not hidden or deleted.
Unknown, hidden, and deleted all return an identical 404, so probing reveals nothing.

**Bypass is a compile error.** `serveMedia` requires a `GateProof`, and that type can
only be constructed inside the gate. `scripts/check-invariants.sh` additionally fails
if anything outside those two modules imports the media store.

**Removal is hide-first.** No name, no email, no account, no explanation, no identity
check. The item is hidden *before* the response is sent, then the organizer reviews.
Marking a request reviewed never un-hides anything. Removal records store only a
random id, the media id, a timestamp, an optional note, and a status — no IP, no user
agent, nothing derived from the request.

**Screenshots.** Download controls are absent and drag/right-click are suppressed.
These are deterrents. A website cannot prevent screenshots and nothing here claims
otherwise.

### Two deliberate tradeoffs, stated plainly

1. **Media bytes are `private, max-age=60`.** `private` forbids CDN and every shared
   cache, which is the real requirement. The 60-second window means a hidden or
   deleted item can stay viewable that long to someone who already loaded it. In
   exchange, revisits and video seeks don't re-download through a function — which
   matters below. Archive-level controls are unaffected; they gate new requests.

2. **Anyone with the code can hide things.** That's the point of hide-first, but it
   means one person could hide the whole archive in a couple of minutes. Recovery is
   `/admin` → **Restore everything hidden**, which reports how many pending requests
   it would override.

---

## Cost and the one real failure mode

Runs entirely on Netlify Free. No database, no auth service, no CDN, no streaming
vendor, nothing to buy. Recurring cost $0.

**Netlify's Free plan is credit-metered: 300 credits/month, and running out pauses
every project on the team until the next billing cycle.** Free has no auto-recharge.
So the archive can go dark *before* the countdown reaches zero. Watch it at
app.netlify.com → team → **Usage**.

This design pushes back on that as hard as it can without weakening the gate: grid
thumbnails are base64-inlined into the already-authenticated archive HTML, so a
40-photo gallery costs **one** function invocation instead of ~41; videos store a
separate 256 KB `head` blob so Safari's tiny `bytes=0-1` probe doesn't drag the whole
file; and the 60-second private cache above stops seeks from re-invoking.

If it ever does pause, media becomes unreachable — a safe failure, but it breaks the
promise to the organizer, so tell her the countdown is not the only clock.

---

## Dependency security

Five advisories were patched during the build, including a critical RCE in
`next@15.5.4` (now `15.5.23`). Three high advisories remain, all inside Next's own
vendored `node_modules/next/node_modules` copies of `postcss` and `sharp`, and both
are unreachable here: Next's bundled sharp only serves Image Optimization, which is
disabled via `images: { unoptimized: true }` plus a ban on `next/image`; its postcss
runs at build time over first-party CSS only. The sole offered fix is `next@16`, a
breaking major. Revisit when a 15.x patch lands.

---

## Deliberately not built

Attendee accounts. An upload UI. Scheduled auto-purge. The subject-consent QR system
(only a reserved `MediaEntry.subjects` field and the gate's predicate list exist as
seams). Native apps. Analytics. Public media URLs. Multi-event support — though every
blob key is namespaced by `FLASHBACK_ARCHIVE_ID`, so a second event is a new
deployment variable rather than a migration.

---

Built with PLUR by [film.fyi](https://film.fyi)
