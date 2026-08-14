/**
 * FLASHBACK ingest. Runs on the PHOTOGRAPHER'S OWN MACHINE, never on Netlify.
 *
 *   npm run ingest -- ./photos [--dry-run] [--featured <filename>]
 *                             [--mute <filename>] [--audio <filename>=<track.m4a>]
 *
 * Netlify Dev uses a sandboxed local blob store that cannot see production data,
 * so this writes to production Blobs directly using NETLIFY_SITE_ID and
 * NETLIFY_API_TOKEN from .env.ingest.local (which is gitignored).
 *
 * Source files are opened read-only and never modified. Originals stay yours:
 * archive visibility and source retention are different policies.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getStore, type Store } from '@netlify/blobs';
import { processPhoto } from './photo';
import { processVideo } from './video';
import { closeExiftool } from './verify-metadata';
import { Progress, logAbove } from '../lib/progress';

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v']);
const RAW_EXT = new Set([
  '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.dng', '.srw', '.pef',
]);

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

interface Cli {
  dir: string;
  dryRun: boolean;
  featured?: string;
  mute: Set<string>;
  audio: Map<string, string>;
}

function parseCli(argv: string[]): Cli {
  const args = argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: npm run ingest -- <directory> [--dry-run] [--featured <file>]');
    process.exit(2);
  }
  const cli: Cli = { dir, dryRun: false, mute: new Set(), audio: new Map() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') cli.dryRun = true;
    else if (a === '--featured') cli.featured = args[++i];
    else if (a === '--mute') {
      const v = args[++i];
      if (v) cli.mute.add(v);
    } else if (a === '--audio') {
      const v = args[++i] ?? '';
      const [f, t] = v.split('=');
      if (f && t) cli.audio.set(f, t);
    }
  }
  return cli;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Put it in .env.ingest.local (gitignored).`);
    console.error('Required: NETLIFY_SITE_ID, NETLIFY_API_TOKEN');
    process.exit(2);
  }
  return v;
}

async function loadDotEnv(file: string) {
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

/** 22 chars, 128 bits. Nothing derived from filename, timestamp, or ordinal. */
const mediaId = () => crypto.randomBytes(16).toString('base64url');

function generateCode(len = 10): string {
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < len) {
    const b = crypto.randomBytes(1)[0] as number;
    if (b >= limit) continue;
    out += CODE_ALPHABET[b % n];
  }
  return out;
}

async function pbkdf2(code: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((res, rej) =>
    crypto.pbkdf2(code, salt, iterations, 32, 'sha256', (e, d) => (e ? rej(e) : res(d))),
  );
}

/** Write, then read the length back. The media store is eventually consistent, so retry. */
async function putWithReadback(
  store: Store,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  // Netlify Blobs wants an ArrayBuffer, not a Node Buffer view.
  const ab = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  await store.set(key, ab, { metadata: { contentType } });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const got = (await store.get(key, { type: 'arrayBuffer' })) as ArrayBuffer | null;
    if (got && got.byteLength === body.byteLength) return;
    if (Date.now() > deadline) {
      throw new Error(`readback mismatch for ${key} (wrote ${body.byteLength})`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  await loadDotEnv('.env.ingest.local');
  const cli = parseCli(process.argv);

  const archiveId = process.env.FLASHBACK_ARCHIVE_ID ?? 'qlick-qrave';
  const eventName = process.env.FLASHBACK_EVENT_NAME ?? 'QLICK QRAVE';

  let meta: Store | null = null;
  let media: Store | null = null;
  if (!cli.dryRun) {
    const siteID = requireEnv('NETLIFY_SITE_ID');
    const token = requireEnv('NETLIFY_API_TOKEN');
    meta = getStore({ name: 'flashback-meta', siteID, token, consistency: 'strong' });
    media = getStore({ name: 'flashback-media', siteID, token });
  }

  const dirents = await fs.readdir(cli.dir, { withFileTypes: true });
  const files = dirents.filter((d) => d.isFile()).map((d) => d.name);

  const work: Array<{ name: string; kind: 'photo' | 'video'; mtimeMs: number }> = [];
  const skipped: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];

  for (const name of files) {
    const ext = path.extname(name).toLowerCase();
    if (RAW_EXT.has(ext)) {
      skipped.push(`${name} (RAW - never upload originals)`);
      continue;
    }
    const kind = PHOTO_EXT.has(ext) ? 'photo' : VIDEO_EXT.has(ext) ? 'video' : null;
    if (!kind) {
      skipped.push(`${name} (unsupported)`);
      continue;
    }
    const st = await fs.stat(path.join(cli.dir, name));
    work.push({ name, kind, mtimeMs: st.mtimeMs });
  }

  // Stable order: capture time, then filename. Ordinal -> label is a pure function.
  work.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));

  interface Built {
    name: string;
    entry: Record<string, unknown>;
    writes: Array<{ key: string; body: Buffer; contentType: string }>;
  }
  const built: Built[] = [];
  let ordinal = 0;

  const procBar = new Progress('processing', work.length);

  for (const item of work) {
    const src = path.join(cli.dir, item.name);
    try {
      const id = mediaId();
      ordinal++;
      const label = `QLK ${String(ordinal).padStart(3, '0')}`;
      const k = (v: string) => `arch/${archiveId}/media/${id}/${v}`;

      if (item.kind === 'photo') {
        const input = await fs.readFile(src);
        const { full, grid } = await processPhoto(input);
        built.push({
          name: item.name,
          entry: {
            mediaId: id,
            type: 'photo',
            label,
            order: ordinal,
            variants: {
              full: { width: full.width, height: full.height, byteLength: full.buffer.byteLength, contentType: full.contentType },
              grid: { width: grid.width, height: grid.height, byteLength: grid.buffer.byteLength, contentType: grid.contentType },
            },
            ingestedAt: new Date().toISOString(),
          },
          writes: [
            { key: k('full'), body: full.buffer, contentType: full.contentType },
            { key: k('grid'), body: grid.buffer, contentType: grid.contentType },
          ],
        });
        logAbove(
          `OK   ${label}  ${item.name}  full ${(full.buffer.byteLength / 1024).toFixed(0)}KB  grid ${(grid.buffer.byteLength / 1024).toFixed(0)}KB`,
        );
      } else {
        procBar.set(ordinal - 1, `encoding ${item.name}`);
        const v = await processVideo(src, {
          mute: cli.mute.has(item.name),
          audioFile: cli.audio.get(item.name),
        });
        built.push({
          name: item.name,
          entry: {
            mediaId: id,
            type: 'video',
            label,
            order: ordinal,
            variants: {
              full: { width: v.full.width, height: v.full.height, byteLength: v.full.buffer.byteLength, contentType: 'video/mp4' },
              poster: { width: v.poster.width, height: v.poster.height, byteLength: v.poster.buffer.byteLength, contentType: v.poster.contentType },
              head: { width: 0, height: 0, byteLength: v.head.byteLength, contentType: 'video/mp4' },
            },
            durationMs: v.durationMs,
            hasAudio: v.hasAudio,
            ingestedAt: new Date().toISOString(),
          },
          writes: [
            { key: k('full'), body: v.full.buffer, contentType: 'video/mp4' },
            { key: k('poster'), body: v.poster.buffer, contentType: v.poster.contentType },
            { key: k('head'), body: Buffer.from(v.head), contentType: 'video/mp4' },
          ],
        });
        logAbove(
          `OK   ${label}  ${item.name}  video ${(v.full.buffer.byteLength / 1048576).toFixed(1)}MB  audio=${v.hasAudio}`,
        );
      }
    } catch (e) {
      ordinal--;
      failed.push({ name: item.name, reason: (e as Error).message });
      logAbove(`FAIL ${item.name}: ${(e as Error).message}`);
    }
    procBar.tick(item.name);
  }
  procBar.done(`${built.length} built, ${failed.length} failed`);

  for (const s of skipped) logAbove(`SKIP ${s}`);

  const gridTotal = built.reduce((sum, b) => {
    const vs = b.entry.variants as Record<string, { byteLength: number }>;
    return sum + (vs.grid?.byteLength ?? 0);
  }, 0);
  const inlineEstimate = Math.ceil(gridTotal * 1.37); // base64 + data URI overhead

  console.log('');
  console.log(`built ${built.length}, skipped ${skipped.length}, failed ${failed.length}`);
  console.log(
    `inlined grid payload ~${(inlineEstimate / 1048576).toFixed(2)}MB (budget 5MB, hard cap 6MB)`,
  );
  if (inlineEstimate > 5 * 1024 * 1024) {
    console.error('WARNING: inlined grid payload exceeds the 5MB budget. Lower GRID_MAX_EDGE.');
  }

  if (cli.dryRun) {
    console.log('\n--dry-run: nothing written to Blobs.');
    await closeExiftool();
    process.exit(failed.length > 0 ? 1 : 0);
  }

  if (!meta || !media) throw new Error('stores unavailable');

  // Bytes first. Until the index lands these are orphans that no route can reach,
  // because the gate's existence check consults the index.
  const totalWrites = built.reduce((n, b) => n + b.writes.length + 1, 0);
  const upBar = new Progress('uploading', totalWrites);

  for (const b of built) {
    for (const w of b.writes) {
      await putWithReadback(media, w.key, w.body, w.contentType);
      upBar.tick(`${b.entry.label as string} ${w.key.split('/').pop() ?? ''}`);
    }
    await meta.setJSON(`arch/${archiveId}/vis/${b.entry.mediaId as string}`, {
      schema: 1,
      mediaId: b.entry.mediaId,
      hidden: false,
      deleted: false,
      rev: 1,
      updatedAt: new Date().toISOString(),
      reason: 'INGEST',
    });
    upBar.tick(`${b.entry.label as string} visibility`);
  }
  upBar.done();

  const featuredEntry =
    built.find((b) => cli.featured && b.name === cli.featured) ??
    built.find((b) => b.entry.type === 'video');

  // Index written LAST, in one set.
  await meta.setJSON(`arch/${archiveId}/index`, {
    schema: 1,
    archiveId,
    entries: built.map((b) => b.entry),
    builtAt: new Date().toISOString(),
  });

  // Config: preserve an existing one, only fill in what is missing.
  const existing = (await meta.get(`arch/${archiveId}/config`, { type: 'json' })) as
    | Record<string, unknown>
    | null;
  const now = new Date().toISOString();
  await meta.setJSON(`arch/${archiveId}/config`, {
    schema: 1,
    archiveId,
    eventName: (existing?.eventName as string) ?? eventName,
    // If the app previously fail-closed because no code existed, seeding one here
    // is what clears that condition, so don't leave the archive locked with no
    // marker explaining why.
    state: existing?.seedFailure ? 'LIVE' : ((existing?.state as string) ?? 'LIVE'),
    expiresAt:
      (existing?.expiresAt as string) ??
      new Date(Date.now() + 12 * 86_400_000).toISOString(),
    codeVersion: (existing?.codeVersion as number) ?? 1,
    featuredMediaId: (featuredEntry?.entry.mediaId as string) ?? null,
    createdAt: (existing?.createdAt as string) ?? now,
    updatedAt: now,
  });

  // Seed the attendee code if none exists. Printed once; keeps the plaintext out
  // of Netlify env vars entirely.
  const codeKey = `arch/${archiveId}/secret/attendee-code`;
  const haveCode = await meta.get(codeKey, { type: 'json' });
  if (!haveCode) {
    const code = generateCode();
    const salt = crypto.randomBytes(16);
    const iterations = 600_000;
    const hash = await pbkdf2(code, salt, iterations);
    await meta.setJSON(codeKey, {
      schema: 1,
      algo: 'pbkdf2-sha256',
      iterations,
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
      codeLength: code.length,
      codeVersion: (existing?.codeVersion as number) ?? 1,
      rotatedAt: now,
    });
    console.log('\n=======================================');
    console.log(`  ATTENDEE CODE:  ${code}`);
    console.log('  Copy it now. It is stored hashed only');
    console.log('  and will not be shown again.');
    console.log('=======================================');
  }

  console.log(`\ndone. featured = ${(featuredEntry?.entry.label as string) ?? 'none'}`);
  await closeExiftool();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('ingest failed:', e);
  await closeExiftool();
  process.exit(1);
});
