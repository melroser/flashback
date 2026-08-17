import { denialResponse, gateGrid } from '@/lib/auth/gate';
import { readGridDataUris } from '@/lib/media/serve';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * The grid manifest.
 *
 * Borrowed from bep/gallerydeluxe, which film.fyi uses: instead of putting the
 * gallery in the page markup, the page carries one pointer and the client fetches
 * a single manifest describing every image.
 *
 * The reason it matters here is specific to Next's App Router. Anything rendered
 * by a Server Component ships twice — once as HTML and again in the RSC hydration
 * payload — so inlining 91 base64 thumbnails cost ~1.44MB for ~0.7MB of images.
 * Moving them out of the React tree entirely is the only way to stop that
 * duplication. One request instead of 91, and each byte sent once.
 *
 * This is behind the same gate as everything else: session, archive enabled, not
 * expired, per-item visibility. Hidden and deleted items never appear.
 */
export async function GET(req: Request) {
  const gate = await gateGrid(req);
  if (!gate.ok) return denialResponse(gate);

  const dataUris = await readGridDataUris(gate.photos);

  const items = gate.photos.flatMap((p) => {
    const dataUri = dataUris.get(p.mediaId);
    const meta = p.entry.variants.grid;
    if (!dataUri || !meta) return [];
    return [
      {
        mediaId: p.mediaId,
        label: p.entry.label,
        width: meta.width,
        height: meta.height,
        dataUri,
      },
    ];
  });

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Same posture as media bytes: never a shared cache, brief private reuse so
      // a revisit inside a minute does not re-invoke the function.
      'cache-control': 'private, max-age=60',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
    },
  });
}
