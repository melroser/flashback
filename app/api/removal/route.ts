import { archiveId } from '@/lib/config/env';
import { denialResponse, gateView } from '@/lib/auth/gate';
import { readIndex, metaStore } from '@/lib/blobs/meta';
import { removalKey } from '@/lib/blobs/keys';
import { setVisibility, rebuildVisSummary } from '@/lib/blobs/vis';
import { randomId } from '@/lib/session/token';
import { checkRate, recordHit, tooManyRequests } from '@/lib/ratelimit';
import type { RemovalRecord } from '@/lib/blobs/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NOTE_MAX = 1000;

const bad = (error: string, status = 400) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

export async function POST(req: Request) {
  const view = await gateView(req);
  if (!view.ok) return denialResponse(view);

  const rate = await checkRate(req, 'removal');
  if (rate.limited) return tooManyRequests();

  let mediaId = '';
  let note: string | undefined;
  try {
    const body = (await req.json()) as { mediaId?: unknown; note?: unknown };
    mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
    if (typeof body.note === 'string') {
      const trimmed = body.note.trim();
      if (trimmed.length > NOTE_MAX) return bad('NOTE_TOO_LONG');
      if (trimmed.length > 0) note = trimmed;
    }
  } catch {
    return bad('INVALID');
  }

  const index = await readIndex();
  const entry = index?.entries.find((e) => e.mediaId === mediaId);
  if (!entry) return bad('NOT_FOUND', 404);

  // HIDE BEFORE RESPONDING. Nobody has to prove they deserve removal, so the
  // policy is hide first and review second. The strong-consistency store makes
  // this immediately effective: a media request issued the instant this response
  // lands already returns 404.
  await setVisibility(entry.mediaId, { hidden: true }, 'REMOVAL_REQUEST');

  // Record built from an explicit ALLOWLIST, never by spreading the parsed body.
  // Extra payload fields are structurally unreachable. No IP, no user agent, no
  // Referer, no session id, nothing derived from the request beyond these fields.
  const record: RemovalRecord = {
    schema: 1,
    recordId: randomId(16),
    mediaId: entry.mediaId,
    submittedAt: new Date().toISOString(),
    ...(note ? { note } : {}),
    status: 'PENDING',
  };

  try {
    await metaStore().setJSON(removalKey(archiveId(), record.recordId), record);
    await rebuildVisSummary();
  } catch {
    // The hide is already in place. Losing the audit record is bad; leaving the
    // media visible would be worse. Report success.
  }

  await recordHit('removal', rate.hash);

  return new Response(JSON.stringify({ ok: true, hidden: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}
