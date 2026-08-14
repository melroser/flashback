import { headers } from 'next/headers';
import { ensureSeeded, readCodeRecord } from '@/lib/blobs/seed';
import { readIndex } from '@/lib/blobs/meta';
import { readAllVisibility, rebuildVisSummary } from '@/lib/blobs/vis';
import { listRemovals } from '@/lib/blobs/removals';
import { isOrganizer } from '@/lib/auth/organizer';
import { siteOrigin } from '@/lib/config/env';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const L = 'text-label uppercase tracking-[0.28em] text-smoke';
const BTN = 'border px-3 py-2 text-label uppercase tracking-[0.28em]';
const FIELD = 'border border-ash bg-void px-2 py-2 text-body text-bone';

export default async function AdminView() {
  const h = await headers();
  const req = new Request('https://flashback.local/admin', {
    headers: new Headers({ cookie: h.get('cookie') ?? '' }),
  });

  // Middleware returns 401/403 with a login form before this renders, but the page
  // re-verifies authoritatively. Middleware is not the authorization boundary.
  if (!(await isOrganizer(req))) {
    return (
      <main className="p-8">
        <p className={L}>Not authorized.</p>
      </main>
    );
  }

  const config = await ensureSeeded();
  const index = await readIndex();
  const entries = [...(index?.entries ?? [])].sort((a, b) => a.order - b.order);
  const vis = await readAllVisibility();
  const removals = await listRemovals();
  await rebuildVisSummary();

  const pendingByMedia = new Map<string, number>();
  for (const r of removals) {
    if (r.status !== 'PENDING') continue;
    pendingByMedia.set(r.mediaId, (pendingByMedia.get(r.mediaId) ?? 0) + 1);
  }

  const photos = entries.filter((e) => e.type === 'photo' && !vis.get(e.mediaId)?.deleted);
  const videos = entries.filter((e) => e.type === 'video' && !vis.get(e.mediaId)?.deleted);
  const hiddenCount = entries.filter(
    (e) => vis.get(e.mediaId)?.hidden && !vis.get(e.mediaId)?.deleted,
  ).length;
  const pendingTotal = removals.filter((r) => r.status === 'PENDING').length;

  const live = config.state === 'LIVE';
  const expired = Date.now() >= Date.parse(config.expiresAt);
  const codeRecord = await readCodeRecord();
  const origin = siteOrigin() ?? '';

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <p className={L}>Flashback / organizer</p>
      <h1 className="font-display text-h2 uppercase text-flash">{config.eventName}</h1>

      {config.seedFailure ? (
        <p className="mt-4 border border-siren bg-tar p-3 text-body text-siren">
          {config.seedFailure}
        </p>
      ) : null}

      {/* Status */}
      <section className="mt-6 grid grid-cols-2 gap-px border border-ash bg-ash sm:grid-cols-4">
        {[
          { k: 'Status', v: expired ? 'ENDED' : live ? 'LIVE' : 'DISABLED' },
          { k: 'Photos', v: String(photos.length) },
          { k: 'Videos', v: String(videos.length) },
          { k: 'Pending removals', v: String(pendingTotal) },
        ].map((c) => (
          <div key={c.k} className="bg-tar p-3">
            <p className={L}>{c.k}</p>
            <p
              className={`mt-1 font-mono text-lg ${
                c.k === 'Status' && !live ? 'text-siren' : 'text-flash'
              }`}
            >
              {c.v}
            </p>
          </div>
        ))}
      </section>

      <p className="mt-2 text-body text-smoke">
        Expires {new Date(config.expiresAt).toUTCString()}
        {hiddenCount > 0 ? ` — ${hiddenCount} item(s) currently hidden` : ''}
      </p>

      {/* THE control that matters most. */}
      <section className="mt-6 border border-ash bg-tar p-4">
        <p className={L}>Archive access</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <form method="post" action="/api/admin/state">
            <input type="hidden" name="state" value="DISABLED" />
            <button
              type="submit"
              disabled={!live}
              className={`${BTN} border-siren text-siren hover:bg-siren hover:text-void disabled:opacity-30`}
            >
              Disable archive
            </button>
          </form>
          <form method="post" action="/api/admin/state">
            <input type="hidden" name="state" value="LIVE" />
            <button
              type="submit"
              disabled={live}
              className={`${BTN} border-acid text-acid hover:bg-acid hover:text-void disabled:opacity-30`}
            >
              Enable archive
            </button>
          </form>
          <form method="post" action="/api/admin/session/logout">
            <button type="submit" className={`${BTN} border-ash text-smoke`}>
              Log out
            </button>
          </form>
        </div>
        <p className="mt-3 text-body text-smoke">
          Disable takes effect immediately. Attendees can&apos;t sign in and existing
          sessions stop loading media.
        </p>
      </section>

      {/* Expiration + code */}
      <section className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="border border-ash bg-tar p-4">
          <p className={L}>Change expiration</p>
          <form method="post" action="/api/admin/expiration" className="mt-3 flex gap-2">
            <input
              type="datetime-local"
              name="expiresAt"
              required
              className={FIELD}
              defaultValue={new Date(config.expiresAt).toISOString().slice(0, 16)}
            />
            <button type="submit" className={`${BTN} border-ash text-bone hover:border-uv`}>
              Set
            </button>
          </form>
          <p className="mt-2 text-body text-smoke">
            A past date ends the archive immediately without deleting anything.
          </p>
        </div>

        <div className="border border-ash bg-tar p-4">
          <p className={L}>Attendee code</p>
          <p className="mt-2 text-body text-smoke">
            {codeRecord
              ? `A code is set (v${codeRecord.codeVersion}, ${codeRecord.codeLength} characters).`
              : 'No code is set.'}{' '}
            The code is stored hashed and never in plaintext, so it can only be shown at the
            moment it is created.
          </p>
          <form method="post" action="/api/admin/code/rotate" className="mt-3">
            <button type="submit" className={`${BTN} border-uv text-bone hover:bg-uv`}>
              Rotate &amp; reveal new code
            </button>
          </form>
          <p className="mt-2 text-body text-smoke">
            Rotating signs every attendee out.
          </p>
        </div>
      </section>

      {/* Distribution text */}
      <section className="mt-4 border border-ash bg-tar p-4">
        <p className={L}>Send to attendees</p>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap border border-ash bg-void p-3 text-body text-bone">
{`FLASHBACK
${config.eventName}
Private archive:
${origin}
Access code:
${codeRecord ? '<rotate to reveal a fresh code>' : '<no code set — rotate to create one>'}`}
        </pre>
      </section>

      {/* Pending removals */}
      {pendingTotal > 0 ? (
        <section className="mt-4 border border-siren bg-tar p-4">
          <p className={L}>Pending removal requests ({pendingTotal})</p>
          <ul className="mt-3 space-y-2">
            {removals
              .filter((r) => r.status === 'PENDING')
              .map((r) => {
                const entry = entries.find((e) => e.mediaId === r.mediaId);
                return (
                  <li key={r.recordId} className="border border-ash bg-void p-3">
                    <p className="font-mono text-body text-flash">
                      {entry?.label ?? 'unknown'}{' '}
                      <span className="text-smoke">
                        {new Date(r.submittedAt).toUTCString()}
                      </span>
                    </p>
                    {r.note ? <p className="mt-1 text-body text-bone">{r.note}</p> : null}
                    <div className="mt-2 flex gap-2">
                      {(['REVIEWED', 'DISMISSED'] as const).map((s) => (
                        <form key={s} method="post" action="/api/admin/removals/review">
                          <input type="hidden" name="recordId" value={r.recordId} />
                          <input type="hidden" name="status" value={s} />
                          <button type="submit" className={`${BTN} border-ash text-smoke hover:text-bone`}>
                            {s === 'REVIEWED' ? 'Mark reviewed' : 'Dismiss'}
                          </button>
                        </form>
                      ))}
                    </div>
                  </li>
                );
              })}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {(['REVIEWED', 'DISMISSED'] as const).map((s) => (
              <form key={s} method="post" action="/api/admin/removals/review">
                <input type="hidden" name="all" value="true" />
                <input type="hidden" name="status" value={s} />
                <button type="submit" className={`${BTN} border-ash text-smoke hover:text-bone`}>
                  {s === 'REVIEWED' ? 'Mark all reviewed' : 'Dismiss all'}
                </button>
              </form>
            ))}
          </div>
          <p className="mt-2 text-body text-smoke">
            Reviewing never un-hides anything. Restoring is always a separate, deliberate
            action.
          </p>
        </section>
      ) : null}

      {/* Bulk recovery */}
      {hiddenCount > 0 ? (
        <section className="mt-4 border border-ash bg-tar p-4">
          <p className={L}>Restore everything hidden ({hiddenCount})</p>
          <p className="mt-2 text-body text-smoke">
            Anyone with the code can hide items, so this exists to undo a mass hide. It
            makes every hidden item visible again, including any with a pending request.
          </p>
          <form method="post" action="/api/admin/media/restore-all" className="mt-3 flex gap-2">
            <input
              type="text"
              name="confirm"
              required
              placeholder={`RESTORE ${hiddenCount} ITEMS`}
              className={FIELD}
            />
            <button type="submit" className={`${BTN} border-acid text-acid hover:bg-acid hover:text-void`}>
              Restore all
            </button>
          </form>
        </section>
      ) : null}

      {/* Media */}
      <section className="mt-4">
        <p className={L}>Media ({entries.length})</p>
        <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {entries.map((e) => {
            const v = vis.get(e.mediaId);
            const pending = pendingByMedia.get(e.mediaId) ?? 0;
            if (v?.deleted) {
              return (
                <li key={e.mediaId} className="border border-ash bg-void p-2 opacity-40">
                  <p className="font-mono text-body text-smoke">{e.label}</p>
                  <p className={L}>Deleted</p>
                </li>
              );
            }
            const thumb =
              e.type === 'video'
                ? e.variants.poster
                  ? `/api/media/${e.mediaId}?v=poster`
                  : null
                : `/api/media/${e.mediaId}?v=grid`;
            return (
              <li key={e.mediaId} className="border border-ash bg-tar p-2">
                {/* Hidden items preview here through the Media_API, authorized by
                    the organizer session. That is what the organizer skip in the
                    gate's visibility check exists for. */}
                {thumb ? (
                  <img
                    src={thumb}
                    alt={`${e.label} preview`}
                    className="mb-2 aspect-square w-full object-cover"
                  />
                ) : null}
                <p className="font-mono text-body text-flash">
                  {e.label}{' '}
                  <span className={L}>{e.type === 'video' ? 'video' : ''}</span>
                </p>

                {v?.hidden ? <p className="text-label uppercase tracking-[0.28em] text-siren">Hidden</p> : null}
                {pending > 0 ? (
                  <p className="text-label uppercase tracking-[0.28em] text-siren">
                    {pending} pending request{pending > 1 ? 's' : ''}
                  </p>
                ) : null}

                <div className="mt-2 space-y-1">
                  <form method="post" action={`/api/admin/media/${e.mediaId}/visibility`}>
                    <input type="hidden" name="hidden" value={v?.hidden ? 'false' : 'true'} />
                    {v?.hidden && pending > 0 ? (
                      <input type="hidden" name="confirmPending" value="yes" />
                    ) : null}
                    <button
                      type="submit"
                      className={`${BTN} w-full border-ash text-smoke hover:text-bone`}
                    >
                      {v?.hidden ? (pending > 0 ? 'Restore (override request)' : 'Restore') : 'Hide'}
                    </button>
                  </form>

                  <details>
                    <summary className={`${L} cursor-pointer`}>Delete</summary>
                    <form
                      method="post"
                      action={`/api/admin/media/${e.mediaId}/delete`}
                      className="mt-1 space-y-1"
                    >
                      <input
                        type="text"
                        name="confirm"
                        required
                        placeholder={`DELETE ${e.label}`}
                        className={`${FIELD} w-full`}
                      />
                      <button
                        type="submit"
                        className={`${BTN} w-full border-siren text-siren hover:bg-siren hover:text-void`}
                      >
                        Delete permanently
                      </button>
                    </form>
                  </details>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Delete all */}
      <section className="mt-6 border border-siren bg-tar p-4">
        <p className={L}>Danger</p>
        <p className="mt-2 text-body text-smoke">
          Permanently removes every file from storage. Your originals on your own machine are
          untouched. This cannot be undone.
        </p>
        <form method="post" action="/api/admin/media/delete-all" className="mt-3 flex gap-2">
          <input
            type="text"
            name="confirm"
            required
            placeholder={`DELETE ALL ${entries.length} ITEMS`}
            className={FIELD}
          />
          <button
            type="submit"
            className={`${BTN} border-siren text-siren hover:bg-siren hover:text-void`}
          >
            Delete everything
          </button>
        </form>
      </section>
    </main>
  );
}
