'use client';

import { useEffect, useRef } from 'react';

/**
 * React does not reliably apply the `muted` DOM property from a JSX attribute
 * across SSR hydration, and `defaultMuted` is not in React's typings at all. So
 * the initial muted state is set imperatively on the element.
 *
 * Muted is only the STARTING state, never pinned: the native volume control
 * stays fully usable, which matters because the audio on this clip was already
 * edited deliberately. No autoplay, so nothing ever makes noise unasked.
 */
export function FeaturedVideo({
  src,
  poster,
  label,
}: {
  src: string;
  poster?: string;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.muted = true;
  }, []);

  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      controls
      muted
      playsInline
      preload="metadata"
      controlsList="nodownload noplaybackrate"
      disablePictureInPicture
      aria-label={`Video ${label} from the night`}
      className="mx-auto block max-h-[38vh] w-auto max-w-full"
    />
  );
}
