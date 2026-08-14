import { denialResponse, gateMedia } from '@/lib/auth/gate';
import { serveMedia } from '@/lib/media/serve';
import type { Variant } from '@/lib/blobs/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const VARIANTS = new Set<Variant>(['full', 'grid', 'poster', 'head']);

function variantFrom(url: string): Variant {
  const v = new URL(url).searchParams.get('v');
  return v && VARIANTS.has(v as Variant) ? (v as Variant) : 'full';
}

async function handle(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
  method: 'GET' | 'HEAD',
) {
  const { id } = await ctx.params;
  const variant = variantFrom(req.url);

  const gate = await gateMedia(req, id, variant);
  if (!gate.ok) return denialResponse(gate);

  return serveMedia(gate.proof, req.headers.get('range'), method);
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, 'GET');
}

export async function HEAD(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, 'HEAD');
}
