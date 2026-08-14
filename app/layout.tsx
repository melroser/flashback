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

export const metadata: Metadata = {
  title: 'FLASHBACK',
  description: 'A private, temporary archive.',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
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
