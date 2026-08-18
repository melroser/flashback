'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface OverlayItem {
  mediaId: string;
  label: string;
}

/**
 * Lightbox and removal dialog for the photograph grid.
 *
 * The grid itself is rendered on the SERVER, and the base64 thumbnails are never
 * passed through client props. If they were, React would serialise them a second
 * time into the Flight hydration payload and the page would carry every thumbnail
 * twice — doubling bandwidth on a credit-metered plan, which is precisely what
 * inlining was meant to avoid.
 *
 * So this component receives only ids and labels, and finds tiles through
 * delegated clicks on `[data-fb-open]` / `[data-fb-remove]`.
 */
export function GridOverlay({ items }: { items: OverlayItem[] }) {
  const [open, setOpen] = useState<OverlayItem | null>(null);
  const [asking, setAsking] = useState<OverlayItem | null>(null);

  const byId = useCallback(
    (id: string | null) => items.find((i) => i.mediaId === id) ?? null,
    [items],
  );

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const openEl = t.closest('[data-fb-open]') as HTMLElement | null;
      const remEl = t.closest('[data-fb-remove]') as HTMLElement | null;
      if (remEl) {
        e.preventDefault();
        setAsking(byId(remEl.getAttribute('data-fb-remove')));
      } else if (openEl) {
        e.preventDefault();
        setOpen(byId(openEl.getAttribute('data-fb-open')));
      }
    };
    // Deterrents. The server-rendered grid cannot carry React event handlers, so
    // drag and context-menu suppression is delegated here. These are deterrents
    // only: a website cannot prevent screenshots and nothing here claims it can.
    const suppress = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.no-save')) e.preventDefault();
    };

    document.addEventListener('click', onClick);
    document.addEventListener('contextmenu', suppress);
    document.addEventListener('dragstart', suppress);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('contextmenu', suppress);
      document.removeEventListener('dragstart', suppress);
    };
  }, [byId]);

  const hideTile = useCallback((mediaId: string) => {
    document.querySelector(`[data-fb-tile="${mediaId}"]`)?.remove();
  }, []);

  return (
    <>
      {open ? <Lightbox item={open} onClose={() => setOpen(null)} /> : null}
      {asking ? (
        <RemovalDialog
          item={asking}
          onClose={() => setAsking(null)}
          onDone={(id) => {
            hideTile(id);
            setAsking(null);
            setOpen(null);
          }}
        />
      ) : null}
    </>
  );
}

const block = (e: React.SyntheticEvent) => e.preventDefault();

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

function Lightbox({ item, onClose }: { item: OverlayItem; onClose: () => void }) {
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
        <button type="button" onClick={onClose} autoFocus className="text-label uppercase tracking-[0.28em] text-acid">
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
    </div>
  );
}

function RemovalDialog({
  item,
  onClose,
  onDone,
}: {
  item: OverlayItem;
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
        setError(res.status === 429 ? 'Too many requests. Wait a minute.' : 'That did not go through.');
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
        {/* No reference label in the heading: `QLK 062` is an internal identifier
            and means nothing to the person in the photograph. */}
        <h2 id="removal-heading" className="font-display text-h2 uppercase text-flash">
          Take image down
        </h2>
        <p className="mt-3 text-body text-smoke">
          You don&apos;t have to explain, and you don&apos;t have to say who you are. Ask and
          it&apos;s hidden right away.
        </p>
        <label htmlFor="note" className="mt-5 block text-label uppercase tracking-[0.28em] text-smoke">
          Anything you want to add
        </label>
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
