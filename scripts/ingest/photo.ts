import sharp from 'sharp';
import { verifyNoMetadata } from './verify-metadata';

export const FULL_MAX_EDGE = 2400;
export const FULL_MAX_BYTES = 1024 * 1024; // 1MB
export const GRID_MAX_EDGE = 400;

/**
 * Grid thumbnails are base64-inlined into the archive HTML, so their total size is
 * bounded by the 6MB buffered response cap. At ~400px and quality 72 a frame lands
 * around 22-30KB. Forty of those is ~1.1MB raw, ~1.5MB once base64 expands it by
 * a third. That leaves comfortable headroom under the 5MB budget.
 */
export const GRID_TARGET_BYTES = 34 * 1024;

const QUALITY_LADDER = [84, 78, 72, 66, 60];
const EDGE_FALLBACK = [FULL_MAX_EDGE, 2000, 1800];

export interface Derivative {
  buffer: Buffer;
  width: number;
  height: number;
  contentType: string;
}

async function encode(
  input: Buffer,
  maxEdge: number,
  quality: number,
): Promise<Derivative> {
  const pipeline = sharp(input)
    // rotate() with NO argument first: this bakes EXIF orientation into the
    // pixels, so discarding EXIF afterwards does not leave the image sideways.
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    // Normalise to sRGB and embed nothing. An sRGB tag is not private data, but a
    // custom camera profile is a camera fingerprint.
    .toColourspace('srgb')
    .jpeg({ quality, progressive: true, chromaSubsampling: '4:2:0', mozjpeg: true });
  // withMetadata() is NEVER called: sharp drops metadata by default and calling
  // it would put some back.

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    width: info.width,
    height: info.height,
    contentType: 'image/jpeg',
  };
}

async function encodeUnderBudget(
  input: Buffer,
  edges: number[],
  budget: number,
  ladder: number[],
): Promise<Derivative> {
  let last: Derivative | null = null;
  for (const edge of edges) {
    for (const q of ladder) {
      const d = await encode(input, edge, q);
      last = d;
      if (d.buffer.byteLength <= budget) return d;
    }
  }
  return last as Derivative;
}

export interface PhotoDerivatives {
  full: Derivative;
  grid: Derivative;
}

export async function processPhoto(input: Buffer): Promise<PhotoDerivatives> {
  const full = await encodeUnderBudget(input, EDGE_FALLBACK, FULL_MAX_BYTES, QUALITY_LADDER);
  const grid = await encodeUnderBudget(
    input,
    [GRID_MAX_EDGE, 320, 280],
    GRID_TARGET_BYTES,
    [76, 70, 64, 58],
  );

  // Both derivatives are real derivatives of a real photograph, so both go
  // through the same verification. A file that fails is never written.
  for (const [name, d] of [
    ['full', full],
    ['grid', grid],
  ] as const) {
    const v = await verifyNoMetadata(d.buffer);
    if (!v.ok) {
      throw new Error(
        `metadata verification failed on ${name} variant: ${v.offending.join(', ')}`,
      );
    }
  }

  return { full, grid };
}
