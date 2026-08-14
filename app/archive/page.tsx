import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { Countdown } from '@/components/Countdown';
import { Footer } from '@/components/Footer';
import { FeaturedVideo } from '@/components/FeaturedVideo';
import { PhotoGrid, type GridItem } from '@/components/PhotoGrid';
import { gateGrid } from '@/lib/auth/gate';
import { readGridDataUris } from '@/lib/media/serve';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

function Ended() {
  return (
    <main className="fx-scan relative flex min-h-dvh flex-col justify-between">
      <div className="flex flex-1 items-center justify-center px-4">
        <p
          className="fx-fringe text-center font-display text-h2 uppercase text-acid"
          style={{ textShadow: '0 0 8px rgba(57,255,106,0.5)' }}
        >
          This flashback has ended.
        </p>
      </div>
      <Footer />
    </main>
  );
}

export default async function ArchiveView() {
  // Reconstruct the incoming Request for the gate. Every authorization decision
  // happens server-side, on every render.
  const h = await headers();
  const req = new Request('https://flashback.local/archive', {
    headers: new Headers({ cookie: h.get('cookie') ?? '' }),
  });

  const gate = await gateGrid(req);

  if (!gate.ok) {
    // Expired: render the ended state with zero media references in the markup.
    if (gate.code === 'ARCHIVE_EXPIRED' || gate.code === 'ARCHIVE_DISABLED') return <Ended />;
    redirect('/');
  }

  const { config, photos, featured, featuredEntry, role } = gate;

  // Grid thumbnails are inlined as base64 into this already-gated, already
  // uncacheable response. That turns ~41 function invocations per grid view into
  // one, which matters because Netlify Free is credit-metered and running out
  // pauses the whole site. The cost is no lazy loading and a larger HTML payload.
  const dataUris = await readGridDataUris(photos);

  const items: GridItem[] = photos.flatMap((p) => {
    const uri = dataUris.get(p.mediaId);
    const meta = p.entry.variants.grid;
    if (!uri || !meta) return [];
    return [
      {
        mediaId: p.mediaId,
        label: p.entry.label,
        dataUri: uri,
        width: meta.width,
        height: meta.height,
      },
    ];
  });

  const createdMs = Date.parse(config.createdAt);
  const expiresMs = Date.parse(config.expiresAt);
  const totalMs = Number.isNaN(createdMs) ? undefined : expiresMs - createdMs;

  return (
    <main className="relative flex min-h-dvh flex-col">
      {/* Sticky hairline bar */}
      <div className="sticky top-0 z-[60] flex h-8 items-center justify-between border-b border-ash bg-void/90 px-3 backdrop-blur">
        <span className="font-display text-sm uppercase tracking-tight text-flash">
          Flashback
        </span>
        <Countdown expiresAt={config.expiresAt} compact />
      </div>

      <div className="px-3 pt-6">
        <p className="text-label uppercase tracking-[0.28em] text-smoke">Private archive</p>
        <h1 className="fx-fringe font-display text-display uppercase leading-[0.82] text-flash">
          {config.eventName}
        </h1>

        {role === 'organizer' ? (
          <p className="mt-2 inline-block border border-uv px-2 py-1 text-label uppercase tracking-[0.28em] text-acid">
            Organizer preview — includes hidden items
          </p>
        ) : null}

        <div className="mt-6 max-w-md">
          <Countdown expiresAt={config.expiresAt} totalMs={totalMs} />
        </div>
      </div>

      {/* Featured video. No autoplay. Muted by default so nobody gets surprised
          by sound, but the volume control still works. */}
      {featured && featuredEntry ? (
        <section className="fx-scan relative mt-8 border-y border-ash bg-black">
          <FeaturedVideo
            src={`/api/media/${featured.mediaId}`}
            poster={
              featuredEntry.variants.poster
                ? `/api/media/${featured.mediaId}?v=poster`
                : undefined
            }
            label={featuredEntry.label}
          />
        </section>
      ) : null}

      {/* Privacy notice. Persistent, not dismissible. Human, not lawyer ToS. */}
      <aside className="mx-3 mt-8 border-l-2 border-uv bg-tar px-4 py-4">
        <p className="text-body text-bone">
          This is a private, temporary archive. Please don&apos;t identify, tag, download,
          screenshot, record or repost anyone in here. Some people in this room have real
          reasons not to be found.
        </p>
        <p className="mt-2 text-body text-smoke">
          If you&apos;re in something and you want it gone, hit{' '}
          <span className="text-bone">Request removal</span>. No name, no explanation, no
          questions. It disappears immediately.
        </p>
      </aside>

      <section className="mt-8 flex-1">
        <PhotoGrid items={items} />
      </section>

      <Footer />
    </main>
  );
}
