import type { NextConfig } from 'next';

// Static header set. Applied here so it covers every Next route including
// route handlers. The per-request CSP (which carries a nonce) is set in
// middleware.ts instead, because the nonce changes on every request.
const STATIC_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // next/image is forbidden for Media_Items: on Netlify it routes through the
  // Netlify Image CDN, which fetches and caches transformed output OUTSIDE our
  // authorization gate. That would be a public cache of protected bytes.
  images: { unoptimized: true },

  // Never leak framework version info.
  poweredByHeader: false,

  async headers() {
    return [
      { source: '/(.*)', headers: STATIC_HEADERS },
      // Authenticated HTML carries the media index and the inlined grid
      // thumbnails, and right after a rotation it carries the code plaintext.
      // It must never be stored. (Media BYTES are private, max-age=60 instead,
      // set in lib/media/serve.ts, so revisits and video seeks do not re-download
      // through a function on a credit-metered plan.)
      {
        source: '/archive',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
      {
        source: '/admin',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
    ];
  },
};

export default nextConfig;
