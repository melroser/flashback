/**
 * Orphan sweep. Re-ingesting writes a fresh index with new opaque ids, so the
 * previous edit's bytes remain in the store, unreachable but paid for. Netlify
 * Blobs has no TTL, so nothing removes them on its own.
 *
 * Only deletes keys belonging to ids from the PREVIOUS index that are absent from
 * the CURRENT one. Anything reachable now is left alone.
 */
import { promises as fs } from 'node:fs';
import { getStore } from '@netlify/blobs';

const VARIANTS = ['full', 'grid', 'thumb', 'poster', 'head'];

async function main() {
  const env = await fs.readFile('.env.ingest.local', 'utf8');
  const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const creds = { siteID: get('NETLIFY_SITE_ID'), token: get('NETLIFY_API_TOKEN') };

  const meta = getStore({ name: 'flashback-meta', ...creds, consistency: 'strong' });
  const media = getStore({ name: 'flashback-media', ...creds });

  const oldIds: string[] = JSON.parse(await fs.readFile('scripts/.orphan-ids.json', 'utf8'));
  const idx = (await meta.get('arch/qlick-qrave/index', { type: 'json' })) as
    | { entries: Array<{ mediaId: string }> }
    | null;
  const live = new Set((idx?.entries ?? []).map((e) => e.mediaId));

  const orphans = oldIds.filter((id) => !live.has(id));
  console.log(`  previous ids ${oldIds.length} | live now ${live.size} | orphaned ${orphans.length}`);

  let bytes = 0;
  let removed = 0;
  for (const id of orphans) {
    for (const v of VARIANTS) {
      const key = `arch/qlick-qrave/media/${id}/${v}`;
      try {
        const buf = (await media.get(key, { type: 'arrayBuffer' })) as ArrayBuffer | null;
        if (!buf) continue;
        bytes += buf.byteLength;
        await media.delete(key);
        removed++;
      } catch {
        /* already gone */
      }
    }
    // Visibility docs for ids no longer in any index are dead weight too.
    await meta.delete(`arch/qlick-qrave/vis/${id}`).catch(() => {});
  }
  console.log(`  deleted ${removed} blobs, reclaimed ${(bytes / 1048576).toFixed(1)} MB`);

  // Safety assertion: nothing currently reachable was touched.
  let intact = 0;
  for (const e of idx?.entries ?? []) {
    const got = (await media.get(`arch/qlick-qrave/media/${e.mediaId}/full`, {
      type: 'arrayBuffer',
    })) as ArrayBuffer | null;
    if (got && got.byteLength > 0) intact++;
  }
  console.log(`  live items still intact: ${intact}/${live.size}`);
  if (intact !== live.size) {
    console.error('  ERROR: a live item lost its bytes. Re-run ingest.');
    process.exit(1);
  }
}
main();
