import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { exiftool } from 'exiftool-vendored';

/**
 * Metadata stripping is VERIFIED, not assumed.
 *
 * Two independent checks, because a naive "strip EXIF" pass leaves things behind:
 *
 *  1. sharp's own view must report no exif / iptc / xmp / icc.
 *  2. exiftool with -G must return only tags inside a structural allowlist.
 *
 * The second check rejects whole GROUPS rather than enumerating tags to remove.
 * That is what catches face regions, which hide in XMP-mwg-rs (Metadata Working
 * Group region structures) and in MakerNotes. An allowlist of groups cannot be
 * defeated by a tag nobody thought to blacklist.
 */
const ALLOWED_GROUPS = new Set(['SourceFile', 'ExifTool', 'File', 'JFIF']);

/**
 * Exact-name exceptions.
 *
 * `Composite:*` is NOT allowlisted as a group, because it also contains
 * GPSPosition, GPSLatitude, GPSLongitude, GPSAltitude, LensID and
 * SubSecDateTimeOriginal - all real leaks. Only these two are permitted, and only
 * because exiftool COMPUTES them from the JPEG's own SOF dimensions rather than
 * reading them from stored metadata. Image dimensions are inherent to the pixels
 * and cannot be private.
 *
 * `errors` and `warnings` are exiftool-vendored's own wrapper fields, not tags
 * present in the file.
 */
const ALLOWED_EXACT = new Set([
  'Composite:ImageSize',
  'Composite:Megapixels',
  'errors',
  'warnings',
  'SourceFile',
  'ExifToolVersion',
]);

export interface VerifyResult {
  ok: boolean;
  offending: string[];
}

export async function verifyNoMetadata(buf: Buffer): Promise<VerifyResult> {
  const offending: string[] = [];

  // Check 1: sharp
  try {
    const m = await sharp(buf).metadata();
    if (m.exif) offending.push('sharp:exif');
    if (m.iptc) offending.push('sharp:iptc');
    if (m.xmp) offending.push('sharp:xmp');
    if (m.icc) offending.push('sharp:icc');
  } catch (e) {
    offending.push(`sharp:unreadable(${(e as Error).message})`);
  }

  // Check 2: exiftool, group-level allowlist
  const tmp = path.join(os.tmpdir(), `fb-verify-${process.pid}-${Date.now()}.jpg`);
  try {
    await fs.writeFile(tmp, buf);
    const raw = (await exiftool.readRaw(tmp, ['-G'])) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (ALLOWED_EXACT.has(key)) continue;
      const group = key.includes(':') ? (key.split(':')[0] as string) : key;
      if (!ALLOWED_GROUPS.has(group)) offending.push(key);
    }
  } catch (e) {
    offending.push(`exiftool:failed(${(e as Error).message})`);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }

  return { ok: offending.length === 0, offending };
}

/** Dumps every tag exiftool can see. Used to prove stripping actually worked. */
export async function dumpTags(buf: Buffer): Promise<string[]> {
  const tmp = path.join(os.tmpdir(), `fb-dump-${process.pid}-${Date.now()}.jpg`);
  try {
    await fs.writeFile(tmp, buf);
    const raw = (await exiftool.readRaw(tmp, ['-G'])) as Record<string, unknown>;
    return Object.keys(raw).filter((k) => !['errors', 'warnings', 'SourceFile'].includes(k));
  } catch {
    return ['<unreadable>'];
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function closeExiftool(): Promise<void> {
  await exiftool.end().catch(() => {});
}
