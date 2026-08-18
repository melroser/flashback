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

  const hiddenEntries = entries.filter(
    (e) => vis.get(e.mediaId)?.hidden && !vis.get(e.mediaId)?.deleted,
  );
  const hiddenCount = hiddenEntries.length;
  // The default restore path holds back anything with a pending removal request, so
  // the confirmation string has to match THAT count, not the total hidden count.
  const restorableCount = hiddenEntries.filter(
    (e) => (pendingByMedia.get(e.mediaId) ?? 0) === 0,
  ).length;
  const heldBackCount = hiddenCount - restorableCount;

  const pendingTotal = removals.filter((r) => r.status === 'PENDING').length;

  const live = config.state === 'LIVE';
  const expiresMs = Date.parse(config.expiresAt);
  const expired = Date.now() >= expiresMs;
  const codeRecord = await readCodeRecord();
  const origin = siteOrigin() ?? '';

  // Her timezone, not GMT. A promoter should not have to convert UTC.
  const expiresLocal = new Date(expiresMs).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const daysLeft = Math.max(0, Math.ceil((expiresMs - Date.now()) / 86_400_000));

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
        {expired
          ? `Ended ${expiresLocal}. Nothing was deleted.`
          : `Shuts off on its own in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — ${expiresLocal}.`}
        {hiddenCount > 0 ? ` ${hiddenCount} item(s) hidden right now.` : ''}
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
        </div>
        <p className="mt-3 text-body text-smoke">
          Disable takes effect immediately. Nobody can sign in and anyone already looking
          stops loading photos. Nothing is deleted — Enable puts it all back.
        </p>
      </section>

      {/* Send to attendees. This block must never instruct a rotation: doing that
          mid-event signs out everyone who already has the code. */}
      <section className="mt-4 border border-ash bg-tar p-4">
        <p className={L}>Send to attendees</p>
        {codeRecord ? (
          <>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap border border-ash bg-void p-3 text-body text-bone">
{`FLASHBACK
${config.eventName}
Private archive:
${origin}
Access code:`}
              <span className="text-smoke">{'  (the code you already have)'}</span>
            </pre>
            <p className="mt-2 text-body text-smoke">
              Flashback stores the code scrambled, so it can&apos;t show it to you again —
              use the one you were given. Everything above is safe to paste anywhere.
            </p>
          </>
        ) : (
          <p className="mt-3 text-body text-siren">
            No code exists yet, so nobody can get in. Create one below first.
          </p>
        )}
      </section>

      {/* Expiration + code */}
      <section className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="border border-ash bg-tar p-4">
          <p className={L}>Change the shut-off date</p>
          <form method="post" action="/api/admin/expiration" className="mt-3 flex gap-2">
            <input
              type="datetime-local"
              name="expiresAt"
              required
              className={FIELD}
              defaultValue={new Date(expiresMs).toISOString().slice(0, 16)}
            />
            <button type="submit" className={`${BTN} border-ash text-bone hover:border-uv`}>
              Set
            </button>
          </form>
          <p className="mt-2 text-body text-smoke">
            Pick a date in the past to end it right now. Nothing gets deleted either way.
          </p>
        </div>

        <div className="border border-ash bg-tar p-4">
          <p className={L}>{codeRecord ? 'Replace the access code' : 'Create the access code'}</p>
          {codeRecord ? (
            <p className="mt-2 text-body text-smoke">
              A code is set and working. You only need this if the code got passed around
              to people who weren&apos;t there.{' '}
              <strong className="text-siren">
                Replacing it locks out everyone currently using the old code
              </strong>{' '}
              — you&apos;d have to send the new one to everybody again.
            </p>
          ) : (
            <p className="mt-2 text-body text-smoke">
              This creates the code attendees type in. It&apos;s shown once, right after you
              tap it — copy it somewhere before leaving the page.
            </p>
          )}
          <form method="post" action="/api/admin/code/rotate" className="mt-3">
            <button
              type="submit"
              className={`${BTN} ${
                codeRecord ? 'border-siren text-siren hover:bg-siren hover:text-void' : 'border-uv text-bone hover:bg-uv'
              }`}
            >
              {codeRecord ? 'Replace code & lock everyone out' : 'Create code'}
            </button>
          </form>
        </div>
      </section>

      {/* Pending removals */}
      {pendingTotal > 0 ? (
        <section className="mt-4 border border-siren bg-tar p-4">
          <p className={L}>People asking to be taken out ({pendingTotal})</p>
          <p className="mt-2 text-body text-smoke">
            These are already hidden from everyone. Nothing is waiting on you — this is just
            so you know.
          </p>
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
                        {new Date(r.submittedAt).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </p>
                    {r.note ? <p className="mt-1 text-body text-bone">{r.note}</p> : null}
                    <div className="mt-2 flex gap-2">
                      {(['REVIEWED', 'DISMISSED'] as const).map((s) => (
                        <form key={s} method="post" action="/api/admin/removals/review">
                          <input type="hidden" name="recordId" value={r.recordId} />
                          <input type="hidden" name="status" value={s} />
                          <button type="submit" className={`${BTN} border-ash text-smoke hover:text-bone`}>
                            {s === 'REVIEWED' ? 'Mark handled' : 'Dismiss'}
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
                  {s === 'REVIEWED' ? 'Mark all handled' : 'Dismiss all'}
                </button>
              </form>
            ))}
          </div>
          <p className="mt-2 text-body text-smoke">
            Marking these never puts a photo back up. Putting one back is always a separate,
            deliberate choice.
          </p>
        </section>
      ) : null}

      {/* Bulk recovery */}
      {hiddenCount > 0 ? (
        <section className="mt-4 border border-ash bg-tar p-4">
          <p className={L}>
            Put hidden photos back ({restorableCount} of {hiddenCount})
          </p>
          <p className="mt-2 text-body text-smoke">
            Anyone with the code can hide photos, so this is here in case someone hides a
            lot of them at once. It puts back everything{' '}
            <strong className="text-bone">except</strong> photos someone asked to be taken
            out of — those stay hidden.
          </p>
          {heldBackCount > 0 ? (
            <p className="mt-2 text-body text-smoke">
              {heldBackCount} photo{heldBackCount > 1 ? 's' : ''} stay{heldBackCount > 1 ? '' : 's'}{' '}
              hidden because someone asked. If you decide to put one back anyway, use its own
              button further down.
            </p>
          ) : null}
          {restorableCount > 0 ? (
            <form
              method="post"
              action="/api/admin/media/restore-all"
              className="mt-3 flex gap-2"
            >
              <input
                type="text"
                name="confirm"
                required
                placeholder={`RESTORE ${restorableCount} ITEMS`}
                className={FIELD}
              />
              <button
                type="submit"
                className={`${BTN} border-acid text-acid hover:bg-acid hover:text-void`}
              >
                Put them back
              </button>
            </form>
          ) : (
            <p className="mt-3 text-body text-smoke">
              Every hidden photo was hidden by request, so there&apos;s nothing to put back
              here.
            </p>
          )}
        </section>
      ) : null}

      {/* Media */}
      <section className="mt-4">
        <p className={L}>Everything in the gallery ({entries.length})</p>
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

                {v?.hidden ? (
                  <p className="text-label uppercase tracking-[0.28em] text-siren">
                    Hidden
                  </p>
                ) : null}
                {pending > 0 ? (
                  <p className="text-label uppercase tracking-[0.28em] text-siren">
                    Someone asked to be taken out
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
                      {v?.hidden
                        ? pending > 0
                          ? 'Put back anyway'
                          : 'Put back'
                        : 'Hide'}
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
                        Delete for good
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
          Wipes every photo and video out of storage for good. The photographer&apos;s own
          copies are untouched. This can&apos;t be undone. If you just want it to go away,
          use <strong className="text-bone">Disable archive</strong> at the top instead —
          that&apos;s reversible.
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

      {/* Log out, deliberately last and far from Disable archive. */}
      <section className="mt-6 border-t border-ash pt-4">
        <form method="post" action="/api/admin/session/logout">
          <button type="submit" className={`${BTN} border-ash text-smoke`}>
            Log out
          </button>
        </form>
      </section>
    </main>
  );
}

