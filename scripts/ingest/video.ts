import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { processPhoto, type Derivative } from './photo';

/**
 * Ceiling for the encoded video.
 *
 * Netlify streams responses up to 20MB, so 18MB leaves headroom. CONTINGENCY: if
 * the deployed check for a full-size video response fails on the free tier, drop
 * this to 5MB and re-run ingest. It is one constant on purpose, so the ship is
 * never blocked on it and no new service is needed.
 */
export const MAX_VIDEO_BYTES = 18 * 1024 * 1024;

/** Must match HEAD_BYTES in lib/media/range.ts. */
export const HEAD_BYTES = 256 * 1024;

/**
 * ffmpeg-static does not always land its binary (postinstall downloads get
 * skipped, blocked, or run on an unsupported arch), so fall back to whatever
 * ffmpeg is on PATH. Resolved once, loudly, rather than failing 90 seconds into
 * an encode with an opaque ENOENT.
 */
function resolveFfmpeg(): string {
  const bundled = ffmpegPath as unknown as string | null;
  if (bundled && existsSync(bundled)) return bundled;
  for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'ffmpeg'; // last resort: rely on PATH
}

const FFMPEG = resolveFfmpeg();

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** Duration in seconds, parsed from ffmpeg's own probe output. Avoids a second binary. */
async function probeDuration(src: string): Promise<number> {
  const { stderr } = await run(['-hide_banner', '-i', src]);
  const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function hasAudioStream(stderr: string): boolean {
  return /Stream #\d+:\d+.*: Audio:/.test(stderr);
}

export interface VideoDerivatives {
  full: Derivative;
  poster: Derivative;
  head: Buffer;
  durationMs: number;
  hasAudio: boolean;
}

export interface VideoOptions {
  /** Drop the source audio entirely. */
  mute?: boolean;
  /** Replace the audio with this file. */
  audioFile?: string;
}

export async function processVideo(
  src: string,
  opts: VideoOptions = {},
): Promise<VideoDerivatives> {
  const duration = await probeDuration(src);
  const probe = await run(['-hide_banner', '-i', src]);
  const sourceHasAudio = hasAudioStream(probe.stderr);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-video-'));
  const outPath = path.join(tmpDir, 'out.mp4');
  const posterPath = path.join(tmpDir, 'poster.jpg');

  try {
    // Budget from duration. A ten-minute SD clip has to live on roughly 240kbps
    // total, so the audio allowance is chosen from what is actually left rather
    // than pinned at 128k, and the video floor is low because 320x240 abstract
    // night footage tolerates it. Overshooting and failing would be worse than a
    // soft-looking frame.
    const totalBudgetBps = duration > 0 ? (MAX_VIDEO_BYTES * 8 * 0.92) / duration : 2_500_000;
    const audioBitrate = opts.mute
      ? 0
      : totalBudgetBps > 600_000
        ? 128_000
        : totalBudgetBps > 300_000
          ? 96_000
          : 64_000;

    let videoBitrate = Math.max(80_000, Math.floor(totalBudgetBps - audioBitrate));

    let encoded: Buffer | null = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const args = [
        '-hide_banner',
        '-y',
        '-i',
        src,
        ...(opts.audioFile ? ['-i', opts.audioFile] : []),
        // Drop ALL container metadata, including creation time and location atoms.
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-map',
        '0:v:0',
      ];

      if (opts.mute) {
        args.push('-an');
      } else if (opts.audioFile) {
        args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', String(audioBitrate), '-shortest');
      } else {
        // The trailing `?` makes the audio mapping optional, so a source with no
        // audio track does not fail the encode. Without an explicit audio map,
        // ffmpeg would silently produce a video with no sound at all.
        args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', String(audioBitrate));
      }

      args.push(
        '-c:v',
        'libx264',
        '-profile:v',
        'high',
        '-level',
        '4.0',
        '-preset',
        'slow',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        "scale='min(1920,iw)':-2",
        '-b:v',
        String(videoBitrate),
        '-maxrate',
        String(Math.floor(videoBitrate * 1.5)),
        '-bufsize',
        String(videoBitrate * 3),
        // Moves the moov atom to the front. Without this, range-based seeking is
        // useless and the `head` variant would be pointless.
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        outPath,
      );

      const r = await run(args);
      if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-500)}`);

      const buf = await fs.readFile(outPath);
      if (buf.byteLength <= MAX_VIDEO_BYTES) {
        encoded = buf;
        break;
      }
      videoBitrate = Math.max(60_000, Math.floor(videoBitrate * 0.75));
    }

    if (!encoded) throw new Error('could not encode video under the size ceiling');

    // Verify the container carries no leftover tags beyond benign codec identifiers.
    const check = await run(['-hide_banner', '-i', outPath]);
    const badTag = /(?:^|\n)\s+(?:location|creation_time|com\.apple)/i.test(check.stderr);
    if (badTag) throw new Error('video container still reports location/creation metadata');

    // Poster frame at 10% in, pushed through the SAME photo pipeline so it is
    // metadata-verified on exactly the same path as a photograph.
    const seek = duration > 0 ? Math.max(0, duration * 0.1) : 0;
    const pr = await run([
      '-hide_banner',
      '-y',
      '-ss',
      String(seek),
      '-i',
      outPath,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      posterPath,
    ]);
    if (pr.code !== 0) throw new Error('poster extraction failed');
    const posterRaw = await fs.readFile(posterPath);
    const { full: poster } = await processPhoto(posterRaw);

    // Dimensions of the encoded video, read off its own poster frame.
    return {
      full: {
        buffer: encoded,
        width: poster.width,
        height: poster.height,
        contentType: 'video/mp4',
      },
      poster,
      head: encoded.subarray(0, Math.min(HEAD_BYTES, encoded.byteLength)),
      durationMs: Math.round(duration * 1000),
      hasAudio: opts.mute ? false : Boolean(opts.audioFile) || sourceHasAudio,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
