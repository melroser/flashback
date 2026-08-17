import { promises as fs } from 'node:fs';
import { getStore } from '@netlify/blobs';
async function main() {
  const env = await fs.readFile('.env.ingest.local', 'utf8');
  const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const store = getStore({
    name: 'flashback-meta',
    siteID: get('NETLIFY_SITE_ID'),
    token: get('NETLIFY_API_TOKEN'),
    consistency: 'strong',
  });
  const idx = (await store.get('arch/qlick-qrave/index', { type: 'json' })) as
    | { entries: Array<{ mediaId: string; label: string }> }
    | null;
  const ids = (idx?.entries ?? []).map((e) => e.mediaId);
  await fs.writeFile('scripts/.orphan-ids.json', JSON.stringify(ids, null, 2));
  console.log(`  saved ${ids.length} previous media ids`);
}
main();
