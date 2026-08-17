import type { Metadata, Viewport } from 'next';
import { Anton, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/**
 * Fonts are fetched at BUILD time and self-hosted by Next, so there is no runtime
 * request to any third party and `font-src 'self'` holds.
 */
const display = Anton({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
});

const mono = IBM_Plex_Mono({
  weight: ['400', '600'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

const EVENT = process.env.FLASHBACK_EVENT_NAME ?? 'QLICK QRAVE';

// Facebook and Instagram require an ABSOLUTE og:image URL; a relative path is
// silently dropped and the card renders with no image. metadataBase is what makes
// Next resolve '/og.jpg' to a full URL.
const ORIGIN =
  process.env.FLASHBACK_SITE_ORIGIN ??
  process.env.URL ??
  process.env.DEPLOY_PRIME_URL ??
  'https://flashback-qlick.netlify.app';

/**
 * Link-preview metadata.
 *
 * This exists because the realistic first contact with this project is a link
 * pasted into an Instagram DM. Without a card, the recipient sees a bare URL and
 * has to decide whether to trust it — which is the wrong first impression for an
 * archive whose entire premise is care.
 *
 * og.jpg is typography and light only. It contains no photograph from the archive,
 * because link crawlers are unauthenticated and anything referenced here is
 * effectively public.
 */
export const metadata: Metadata = {
  metadataBase: new URL(ORIGIN),
  title: `FLASHBACK — ${EVENT}`,
  description: `Photographs from ${EVENT}. A private archive, locked and built to disappear.`,
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
  openGraph: {
    type: 'website',
    siteName: 'FLASHBACK',
    title: `FLASHBACK — ${EVENT}`,
    description: 'Photographs from the night. Locked, and built to disappear.',
    images: [{ url: '/og.jpg', width: 1200, height: 630, alt: 'FLASHBACK — private archive' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: `FLASHBACK — ${EVENT}`,
    description: 'Photographs from the night. Locked, and built to disappear.',
    images: ['/og.jpg'],
  },
};

export const viewport: Viewport = {
  themeColor: '#080809',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body className="fx-grain fx-vignette fx-leak min-h-dvh bg-void text-bone antialiased">
        {children}
      </body>
    </html>
  );
}
