'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface GridItem {
  mediaId: string;
  label: string;
  /** Absent on manifests served before clips were indexed; treated as a photo. */
  type?: 'photo' | 'video';
  width: number;
  height: number;
  durationMs?: number;
  dataUri: string;
}

const isClip = (i: GridItem) => i.type === 'video';

function runtime(ms: number | undefined): string {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const block = (e: React.SyntheticEvent) => e.preventDefault();

/**
 * Fetches the grid manifest once and renders the contact sheet.
 *
 * The thumbnails deliberately do not come through server props. Anything in the
 * Server Component tree is serialised a second time into the RSC hydration
 * payload, so 0.7MB of thumbnails became a 1.44MB page. One fetch keeps each byte
 * on the wire exactly once.
 */
export function PhotoGridClient({ count }: { count: number }) {
  const [items, setItems] = useState<GridItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<GridItem | null>(null);
  const [asking, setAsking] = useState<GridItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recovering = useRef(false);

  /**
   * Recovers a tab that is holding a manifest from before an ingest.
   *
   * Re-ingest mints a fresh mediaId for every item and the orphan sweep deletes the
   * old bytes, so every id in an older manifest 404s. The failure is invisible in
   * the grid, because thumbnails are inline data URIs that need no network — the
   * contact sheet looks perfectly healthy while every lightbox is broken.
   *
   * On a full-size load failure we refetch the manifest. If the id is genuinely
   * gone, the grid is replaced wholesale and the lightbox closes.
   *
   * We deliberately do NOT re-map the dead item onto a new id by matching labels.
   * Labels are positional, so any reorder would quietly surface a different
   * person's photograph under the label the viewer clicked. That is the one failure
   * this archive must never produce, and a reload notice is the cheap price of
   * never producing it.
   */
  const recoverFromStaleManifest = useCallback(async (staleId: string) => {
    if (recovering.current) return;
    recovering.current = true;
    try {
      const r = await fetch('/api/grid', { cache: 'no-store' });
      if (!r.ok) return;
      const d = (await r.json()) as { items: GridItem[] };
      const stillListed = d.items.some((i) => i.mediaId === staleId);
      setItems(d.items);
      if (!stillListed) {
        setLightbox(null);
        setNotice(
          'This archive was updated while your tab was open. The photographs have been reloaded.',
        );
      }
    } catch {
      // Leave the broken frame in place. The alt text already names the item, and
      // guessing is worse than saying nothing.
    } finally {
      recovering.current = false;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/api/grid')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { items: GridItem[] }) => {
        if (alive) setItems(d.items);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <p className="px-4 py-16 text-center text-body text-siren">
        Couldn&apos;t load the photographs. Reload the page.
      </p>
    );
  }

  // Skeleton sized from the real count, so the page does not jump when it lands.
  if (!items) {
    return (
      <ul
        aria-busy="true"
        aria-label="Loading photographs"
        className="grid grid-cols-1 gap-[2px] sm:grid-cols-2 lg:grid-cols-3 lg:gap-[3px] 2xl:grid-cols-4"
      >
        {Array.from({ length: Math.min(count, 12) }).map((_, i) => (
          <li key={i} className="aspect-[3/2] animate-pulse bg-tar" />
        ))}
      </ul>
    );
  }

  const visible = items.filter((i) => !removed.has(i.mediaId));

  return (
    <>
      {notice ? (
        <p
          role="status"
          className="mb-3 border-l-2 border-uv bg-tar px-3 py-2 text-body text-bone"
        >
          {notice}
        </p>
      ) : null}

      <ul className="grid grid-cols-1 gap-[2px] sm:grid-cols-2 lg:grid-cols-3 lg:gap-[3px] 2xl:grid-cols-4">
        {visible.map((item, idx) => (
          <li key={item.mediaId} className="relative bg-tar">
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setLightbox(item);
              }}
              aria-label={`Open ${item.label} larger`}
              className="relative block w-full"
            >
              {/* Plain <img>. next/image would route through the Netlify Image CDN,
                  caching transformed protected bytes outside the gate.

                  A clip shows its poster frame here, which is inlined in the same
                  manifest. No video bytes are touched until the tile is opened, so
                  a grid load costs the same whether or not clips are present. */}
              <img
                src={item.dataUri}
                alt={
                  isClip(item)
                    ? `Clip ${item.label} from the night`
                    : `Photograph ${item.label} from the night`
                }
                width={item.width}
                height={item.height}
                draggable={false}
                onDragStart={block}
                onContextMenu={block}
                decoding="async"
                className="no-save block h-auto w-full border border-transparent hover:border-acid"
                style={{ aspectRatio: `${item.width} / ${item.height}` }}
              />

              {isClip(item) ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1.5 border border-acid/70 bg-void/80 px-1.5 py-0.5 text-label uppercase tracking-[0.28em] text-acid"
                >
                  <svg width="8" height="9" viewBox="0 0 8 9" fill="currentColor">
                    <path d="M0 0l8 4.5L0 9z" />
                  </svg>
                  {runtime(item.durationMs)}
                </span>
              ) : null}
            </button>

            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <span
                className="tape px-1.5 py-0.5 text-label uppercase tracking-[0.28em] text-smoke"
                style={{ transform: `rotate(${idx % 2 === 0 ? '-0.4deg' : '0.4deg'})` }}
              >
                {item.label}
              </span>
              <button
                type="button"
                onClick={() => setAsking(item)}
                className="text-label uppercase tracking-[0.28em] text-smoke underline decoration-ash underline-offset-4 hover:text-siren"
              >
                Request removal
              </button>
            </div>
          </li>
        ))}
      </ul>

      {visible.length === 0 ? (
        <p className="px-4 py-16 text-center text-body text-smoke">Nothing here right now.</p>
      ) : null}

      {lightbox ? (
        <Lightbox
          item={lightbox}
          onClose={() => setLightbox(null)}
          onStale={recoverFromStaleManifest}
        />
      ) : null}

      {asking ? (
        <RemovalDialog
          item={asking}
          onClose={() => setAsking(null)}
          onDone={(id) => {
            setRemoved((s) => new Set(s).add(id));
            setAsking(null);
            setLightbox(null);
          }}
        />
      ) : null}
    </>
  );
}

function useDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, input, textarea, a[href]');
        if (f.length === 0) return;
        const first = f[0] as HTMLElement;
        const last = f[f.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return ref;
}

function Lightbox({
  item,
  onClose,
  onStale,
}: {
  item: GridItem;
  onClose: () => void;
  onStale: (mediaId: string) => void;
}) {
  const ref = useDismiss(onClose);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`${item.label} enlarged`}
      className="fixed inset-0 z-[80] flex flex-col bg-void/[0.97] p-2"
    >
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-label uppercase tracking-[0.28em] text-smoke">{item.label}</span>
        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="text-label uppercase tracking-[0.28em] text-acid"
        >
          Close
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-hidden">
        {isClip(item) ? (
          /* No autoplay, muted by default, controls intact — the same posture as
             the featured video. `preload="metadata"` means opening a clip costs a
             few KB; the megabytes only move if the viewer presses play. */
          <video
            src={`/api/media/${item.mediaId}`}
            poster={`/api/media/${item.mediaId}?v=poster`}
            controls
            muted
            playsInline
            preload="metadata"
            controlsList="nodownload noplaybackrate"
            disablePictureInPicture
            onContextMenu={block}
            onError={() => onStale(item.mediaId)}
            aria-label={`Clip ${item.label} from the night`}
            className="no-save max-h-full max-w-full"
          />
        ) : (
          /* Full derivative fetched on demand through the authenticated route. */
          <img
            src={`/api/media/${item.mediaId}?v=full`}
            alt={`Photograph ${item.label} from the night`}
            draggable={false}
            onDragStart={block}
            onContextMenu={block}
            // A failure here is almost always a manifest from before an ingest, so
            // the id no longer resolves. Ask the parent to refetch rather than
            // leaving the viewer with the browser's broken-image glyph.
            onError={() => onStale(item.mediaId)}
            className="no-save max-h-full max-w-full object-contain"
          />
        )}
      </div>
    </div>
  );
}

function RemovalDialog({
  item,
  onClose,
  onDone,
}: {
  item: GridItem;
  onClose: () => void;
  onDone: (mediaId: string) => void;
}) {
  const ref = useDismiss(onClose);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/removal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaId: item.mediaId, note: note.trim() || undefined }),
      });
      if (!res.ok) {
        setError(
          res.status === 429 ? 'Too many requests. Wait a minute.' : 'That did not go through.',
        );
        setBusy(false);
        return;
      }
      onDone(item.mediaId);
    } catch {
      setError('That did not go through.');
      setBusy(false);
    }
  }, [item.mediaId, note, onDone]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="removal-heading"
      className="fixed inset-0 z-[85] flex items-center justify-center bg-void/95 p-4"
    >
      <div className="w-full max-w-md border border-ash bg-tar p-5">
        {/* No reference label in the heading. `QLK 062` is an internal identifier
            and means nothing to the person in the photograph; the API carries the
            mediaId, so the request is unambiguous without showing it. */}
        <h2 id="removal-heading" className="font-display text-h2 uppercase text-flash">
          Take {isClip(item) ? 'clip' : 'image'} down
        </h2>
        <p className="mt-3 text-body text-smoke">
          You don&apos;t have to explain, and you don&apos;t have to say who you are. Ask and
          it&apos;s hidden right away.
        </p>
        <label
          htmlFor="note"
          className="mt-5 block text-label uppercase tracking-[0.28em] text-smoke"
        >
          Anything you want to add
        </label>
        {/* The field starts empty and says only `Optional`. The old prompt asked for
            "e.g. left side of the frame", which reads as a required description of
            where you are in the frame — the last thing to ask of someone who wants
            out of it. */}
        <textarea
          id="note"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 1000))}
          rows={3}
          className="mt-2 w-full border border-ash bg-void p-2 text-body text-bone placeholder:text-smoke/50 focus:border-uv"
          placeholder="Optional"
        />
        <p className="mt-1 text-label uppercase tracking-[0.28em] text-smoke">{note.length}/1000</p>
        {error ? <p className="mt-3 text-body text-siren">{error}</p> : null}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            autoFocus
            className="flex-1 border border-siren/50 px-4 py-3 text-label uppercase tracking-[0.28em] text-siren hover:bg-siren hover:text-void disabled:opacity-40"
          >
            {busy ? 'Hiding' : 'Hide it now'}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="border border-ash px-4 py-3 text-label uppercase tracking-[0.28em] text-smoke hover:text-bone"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
