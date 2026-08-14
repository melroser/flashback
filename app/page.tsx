import { AccessForm } from '@/components/AccessForm';
import { Footer } from '@/components/Footer';
import { ensureSeeded } from '@/lib/blobs/seed';
import { eventName } from '@/lib/config/env';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export default async function AccessScreen() {
  // Read only what is needed to choose between the code form and the ended state.
  // No media, no identifiers.
  let ended = false;
  let name = eventName();
  try {
    const config = await ensureSeeded();
    name = config.eventName;
    ended = Date.now() >= Date.parse(config.expiresAt);
  } catch {
    // Fail closed: with unreadable state, offer nothing.
    ended = true;
  }

  return (
    <main className="relative flex min-h-dvh flex-col justify-between">
      <div className="flex flex-1 flex-col justify-center px-4 py-16">
        <p className="text-label uppercase tracking-[0.28em] text-smoke">Private archive</p>

        <h1 className="fx-fringe mt-2 font-display text-display uppercase text-flash">
          Flashback
        </h1>

        <h2 className="mt-1 font-display text-h2 uppercase text-smoke">{name}</h2>

        <div className="mt-10">
          {ended ? (
            <p className="fx-fringe font-display text-h2 uppercase text-acid">
              This flashback has ended.
            </p>
          ) : (
            <AccessForm />
          )}
        </div>

        {!ended ? (
          <p className="mt-10 max-w-sm text-body text-smoke">
            You were there. This is what remains, for a little while.
          </p>
        ) : null}
      </div>

      <Footer />
    </main>
  );
}
