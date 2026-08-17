'use client';

/**
 * The redacted EXIF block.
 *
 * A film photography site normally shows this data off: camera, lens, aperture,
 * exposure, GPS. FLASHBACK strips all of it during ingest and verifies the strip
 * twice. This component renders the SHAPE of that readout with the values
 * destroyed, so the privacy work is visible instead of invisible.
 *
 * NO DATA IS SENT. Nothing is scrambled client-side from a real value, because no
 * real value exists in the archive — the derivative genuinely has no EXIF. The
 * glyphs are generated locally from the media id purely so each frame looks
 * consistent between renders rather than reshuffling and looking broken.
 *
 * Deliberate design constraint: the glyphs are blocks and strikethroughs, not
 * base64-looking noise. Ciphertext would imply "we hold this and won't show you",
 * which is a false claim about the privacy model. This has to read as gone.
 */

const BLOCKS = ['█', '▓', '▒', '░'];

/** Small deterministic PRNG so a frame's redaction is stable across renders. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return Math.abs(h) / 2 ** 31;
  };
}

function redact(rand: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += BLOCKS[Math.floor(rand() * BLOCKS.length)] as string;
  }
  return out;
}

const FIELDS: Array<{ label: string; len: number }> = [
  { label: 'Camera', len: 9 },
  { label: 'Lens', len: 7 },
  { label: 'Aperture', len: 4 },
  { label: 'Shutter', len: 5 },
  { label: 'ISO', len: 4 },
  { label: 'Captured', len: 11 },
  { label: 'Serial', len: 8 },
  { label: 'Artist', len: 6 },
];

export function StrippedExif({ mediaId }: { mediaId: string }) {
  const rand = seeded(mediaId);

  return (
    <div className="border border-ash bg-void/80 p-3">
      <p className="text-label uppercase tracking-[0.28em] text-smoke">
        Camera data — removed
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
        {FIELDS.map((f) => (
          <div key={f.label} className="flex items-baseline justify-between gap-2">
            <dt className="text-label uppercase tracking-[0.2em] text-smoke/70">{f.label}</dt>
            <dd
              aria-hidden="true"
              className="select-none font-mono text-[0.7rem] leading-none text-smoke/35 line-through decoration-siren/60"
            >
              {redact(rand, f.len)}
            </dd>
          </div>
        ))}

        {/* GPS gets its own row. It is the field that actually matters here. */}
        <div className="col-span-2 mt-2 flex items-baseline justify-between gap-2 border-t border-ash pt-2">
          <dt className="text-label uppercase tracking-[0.2em] text-siren">Location</dt>
          <dd
            aria-hidden="true"
            className="select-none font-mono text-[0.7rem] leading-none text-smoke/35 line-through decoration-siren"
          >
            {redact(rand, 8)}.{redact(rand, 4)} {redact(rand, 9)}.{redact(rand, 4)}
          </dd>
        </div>
      </dl>

      {/* The honest sentence. Screen readers get this instead of the glyphs. */}
      <p className="mt-3 text-[0.7rem] leading-relaxed text-smoke">
        This frame carries no camera data. Location, serial number, timestamps and
        creator fields were stripped before upload and verified twice. Nothing above
        was ever sent to your browser — those marks are where the data used to be.
      </p>
    </div>
  );
}
