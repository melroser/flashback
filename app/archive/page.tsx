import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { Countdown } from '@/components/Countdown';
import { Footer } from '@/components/Footer';
import { FeaturedVideo } from '@/components/FeaturedVideo';
import { PhotoGridClient } from '@/components/PhotoGridClient';
import { gateGrid } from '@/lib/auth/gate';

function FormLink() {
  return (
    <form method="post" action="/api/admin/session/logout" className="inline">
      <button
        type="submit"
        className="text-acid underline decoration-ash underline-offset-4 hover:text-flash"
      >
        Log out
      </button>
    </form>
  );
}

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
  // Every authorization decision happens server-side, on every render.
  const h = await headers();
  const req = new Request('https://flashback.local/archive', {
    headers: new Headers({ cookie: h.get('cookie') ?? '' }),
  });

  const gate = await gateGrid(req);

  if (!gate.ok) {
    // Expired or disabled: render the ended state with zero media references.
    if (gate.code === 'ARCHIVE_EXPIRED' || gate.code === 'ARCHIVE_DISABLED') return <Ended />;
    redirect('/');
  }

  const { config, photos, videos, featured, featuredEntry, role } = gate;

  // Thumbnails are NOT read or embedded here. They arrive from GET /api/grid in a
  // single request, because anything rendered by a Server Component also ships
  // inside the RSC hydration payload — which meant every thumbnail was sent twice
  // and made this page 1.44MB for 0.7MB of images.
  // Skeleton size only. Clips sit in the same grid as the photographs so that each
  // one carries its own Request removal control — a clip of this room needs that
  // path at least as much as a still does.
  const tileCount = photos.length + videos.length;

  const createdMs = Date.parse(config.createdAt);
  const expiresMs = Date.parse(config.expiresAt);
  const totalMs = Number.isNaN(createdMs) ? undefined : expiresMs - createdMs;

  return (
    <main className="relative flex min-h-dvh flex-col">
      {/* Sticky hairline bar */}
      <div className="sticky top-0 z-[60] flex h-8 items-center justify-between border-b border-ash bg-void/90 px-3 backdrop-blur">
        <span className="font-display text-sm uppercase tracking-tight text-flash">Flashback</span>
        <Countdown expiresAt={config.expiresAt} compact />
      </div>

      <div className="px-3 pt-6">
        <p className="text-label uppercase tracking-[0.28em] text-smoke">Private archive</p>
        <h1 className="fx-fringe font-display text-display uppercase leading-[0.82] text-flash">
          {config.eventName}
        </h1>

        {/* Plain status, no preview mode. Hidden photos are hidden here for
            everyone, so there are no two views to switch between. */}
        {role === 'organizer' ? (
          <p className="mt-3 text-label uppercase tracking-[0.28em] text-smoke">
            Signed in as admin ·{' '}
            <a href="/admin" className="text-bone underline decoration-ash underline-offset-4 hover:text-acid">
              Admin
            </a>{' '}
            ·{' '}
            <FormLink />
          </p>
        ) : null}

        <div className="mt-6 max-w-md">
          <Countdown expiresAt={config.expiresAt} totalMs={totalMs} />
        </div>
      </div>

      {/* Featured video. No autoplay, muted by default, volume control intact. */}
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

      {/* Persistent, not dismissible. Human, not lawyer ToS. */}
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
        <PhotoGridClient count={tileCount} />
      </section>

      <Footer />
    </main>
  );
}
