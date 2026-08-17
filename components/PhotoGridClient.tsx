'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { StrippedExif } from './StrippedExif';

interface GridItem {
  mediaId: string;
  label: string;
  width: number;
  height: number;
  dataUri: string;
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
      <ul className="grid grid-cols-1 gap-[2px] sm:grid-cols-2 lg:grid-cols-3 lg:gap-[3px] 2xl:grid-cols-4">
        {visible.map((item, idx) => (
          <li key={item.mediaId} className="relative bg-tar">
            <button
              type="button"
              onClick={() => setLightbox(item)}
              aria-label={`Open ${item.label} larger`}
              className="block w-full"
            >
              {/* Plain <img>. next/image would route through the Netlify Image CDN,
                  caching transformed protected bytes outside the gate. */}
              <img
                src={item.dataUri}
                alt={`Photograph ${item.label} from the night`}
                width={item.width}
                height={item.height}
                draggable={false}
                onDragStart={block}
                onContextMenu={block}
                decoding="async"
                className="no-save block h-auto w-full border border-transparent hover:border-acid"
                style={{ aspectRatio: `${item.width} / ${item.height}` }}
              />
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

      {lightbox ? <Lightbox item={lightbox} onClose={() => setLightbox(null)} /> : null}

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

function Lightbox({ item, onClose }: { item: GridItem; onClose: () => void }) {
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
        {/* Full derivative fetched on demand through the authenticated route. */}
        <img
          src={`/api/media/${item.mediaId}?v=full`}
          alt={`Photograph ${item.label} from the night`}
          draggable={false}
          onDragStart={block}
          onContextMenu={block}
          className="no-save max-h-full max-w-full object-contain"
        />
      </div>

      {/* Where a film site would show off the EXIF. Ours shows its absence. */}
      <div className="mx-auto w-full max-w-md shrink-0 pb-1 pt-2">
        <details>
          <summary className="cursor-pointer list-none text-label uppercase tracking-[0.28em] text-smoke hover:text-bone">
            Camera data — removed
          </summary>
          <div className="mt-2">
            <StrippedExif mediaId={item.mediaId} />
          </div>
        </details>
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
        <h2 id="removal-heading" className="font-display text-h2 uppercase text-flash">
          Take {item.label} down
        </h2>
        <p className="mt-3 text-body text-smoke">
          You don&apos;t have to explain, and you don&apos;t have to say who you are. Ask and
          it&apos;s hidden right away.
        </p>
        <label
          htmlFor="note"
          className="mt-5 block text-label uppercase tracking-[0.28em] text-smoke"
        >
          Anything that helps (optional)
        </label>
        <textarea
          id="note"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 1000))}
          rows={3}
          className="mt-2 w-full border border-ash bg-void p-2 text-body text-bone focus:border-uv"
          placeholder="e.g. left side of the frame"
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
