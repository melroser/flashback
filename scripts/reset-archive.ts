/**
 * Wipes an entire archive namespace: media bytes, the index, every visibility
 * document, the config, the attendee code hash, removal records and rate-limit
 * counters.
 *
 * This is NOT what the admin "Delete everything" button does. That deletes media
 * bytes and marks items deleted, but leaves the index, config, access code and
 * removal history behind. This removes the whole namespace so the next ingest
 * starts genuinely clean and mints a brand new access code.
 *
 *   npx tsx scripts/reset-archive.ts                        # dry run, lists only
 *   npx tsx scripts/reset-archive.ts --yes-delete-everything
 *   npx tsx scripts/reset-archive.ts --archive qlick-2 --yes-delete-everything
 *
 * Your original photographs are never touched. This only clears what was uploaded.
 */
import { promises as fs } from 'node:fs';
import { getStore, type Store } from '@netlify/blobs';

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes-delete-everything');
const archiveId =
  args[args.indexOf('--archive') + 1] && args.includes('--archive')
    ? (args[args.indexOf('--archive') + 1] as string)
    : (process.env.FLASHBACK_ARCHIVE_ID ?? 'qlick-qrave');

async function creds() {
  const env = await fs.readFile('.env.ingest.local', 'utf8').catch(() => '');
  const get = (k: string) =>
    process.env[k] ?? env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const siteID = get('NETLIFY_SITE_ID');
  const token = get('NETLIFY_API_TOKEN');
  if (!siteID || !token) {
    console.error('Missing NETLIFY_SITE_ID / NETLIFY_API_TOKEN (.env.ingest.local).');
    process.exit(2);
  }
  return { siteID, token };
}

async function wipe(store: Store, prefix: string, label: string): Promise<number> {
  let keys: string[] = [];
  try {
    const { blobs } = await store.list({ prefix });
    keys = blobs.map((b) => b.key);
  } catch (e) {
    console.error(`  ${label}: list failed — ${(e as Error).message}`);
    return 0;
  }
  if (keys.length === 0) {
    console.log(`  ${label}: nothing to remove`);
    return 0;
  }
  if (!CONFIRMED) {
    console.log(`  ${label}: ${keys.length} object(s) WOULD be deleted`);
    for (const k of keys.slice(0, 4)) console.log(`      ${k}`);
    if (keys.length > 4) console.log(`      ... and ${keys.length - 4} more`);
    return keys.length;
  }
  let n = 0;
  for (const k of keys) {
    try {
      await store.delete(k);
      n++;
    } catch {
      /* already gone */
    }
  }
  console.log(`  ${label}: deleted ${n}/${keys.length}`);
  return n;
}

async function main() {
  const c = await creds();
  const meta = getStore({ name: 'flashback-meta', ...c, consistency: 'strong' });
  const media = getStore({ name: 'flashback-media', ...c });
  const prefix = `arch/${archiveId}/`;

  console.log(`\nArchive namespace: ${prefix}`);
  console.log(CONFIRMED ? 'MODE: DELETING\n' : 'MODE: dry run (pass --yes-delete-everything to apply)\n');

  const before = (await meta.get(`${prefix}index`, { type: 'json' })) as
    | { entries: unknown[] }
    | null;
  console.log(`  current index: ${before ? `${before.entries.length} item(s)` : 'absent'}`);

  const a = await wipe(media, prefix, 'media bytes');
  const b = await wipe(meta, prefix, 'metadata, code hash, removals, rate limits');

  if (!CONFIRMED) {
    console.log(`\n  ${a + b} object(s) would be removed. Nothing changed.`);
    console.log('  Re-run with --yes-delete-everything to apply.\n');
    return;
  }

  // Prove it is gone.
  const idx = await meta.get(`${prefix}index`, { type: 'json' });
  const code = await meta.get(`${prefix}secret/attendee-code`, { type: 'json' });
  const cfg = await meta.get(`${prefix}config`, { type: 'json' });
  console.log('\n  verification:');
  console.log(`    index        ${idx ? 'STILL PRESENT' : 'gone'}`);
  console.log(`    access code  ${code ? 'STILL PRESENT' : 'gone'}`);
  console.log(`    config       ${cfg ? 'STILL PRESENT' : 'gone'}`);
  if (idx || code || cfg) {
    console.error('\n  Reset incomplete. Re-run.\n');
    process.exit(1);
  }
  console.log(`\n  Clean. Next ingest will mint a NEW access code.\n`);
}

main().catch((e) => {
  console.error('reset failed:', e);
  process.exit(1);
});
