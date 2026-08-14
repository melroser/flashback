'use client';

import { useEffect, useState } from 'react';

function parts(msLeft: number) {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Display only. The server value is the only thing that authorises anything;
 * a client clock cannot extend or shorten access.
 *
 * Deliberately NOT in an ARIA live region: a screen reader user should not be
 * interrupted every 30 seconds for a value they cannot act on. The remaining time
 * is plain static text they can navigate to whenever they want it.
 */
export function Countdown({
  expiresAt,
  totalMs,
  compact = false,
}: {
  expiresAt: string;
  totalMs?: number;
  compact?: boolean;
}) {
  const target = Date.parse(expiresAt);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const left = target - now;
  const { days, hours, minutes } = parts(left);
  const urgent = left < 86_400_000;
  const fraction = totalMs && totalMs > 0 ? Math.max(0, Math.min(1, left / totalMs)) : null;

  if (compact) {
    return (
      <span
        className={`font-mono tabular-nums ${urgent ? 'text-siren' : 'text-flash'}`}
        title="Time remaining before this archive disappears"
      >
        {days}d {pad(hours)}h {pad(minutes)}m
      </span>
    );
  }

  return (
    <div>
      <p className="text-label uppercase tracking-[0.28em] text-smoke">
        This flashback disappears in
      </p>

      <p
        className={`mt-2 font-mono text-countdown tabular-nums ${
          urgent ? 'text-siren' : 'text-flash'
        }`}
      >
        <span>{days}</span>
        <span className="ml-1 text-label uppercase tracking-[0.28em] text-smoke">days</span>
        <span className="ml-3">{pad(hours)}</span>
        <span className="ml-1 text-label uppercase tracking-[0.28em] text-smoke">hrs</span>
        <span className="ml-3">{pad(minutes)}</span>
        <span className="ml-1 text-label uppercase tracking-[0.28em] text-smoke">min</span>
      </p>

      {/* A strip of tape shortening across the page. */}
      {fraction !== null ? (
        <div className="mt-3 h-px w-full bg-ash" aria-hidden="true">
          <div
            className={urgent ? 'h-px bg-siren' : 'h-px bg-uv'}
            style={{ width: `${(fraction * 100).toFixed(2)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
