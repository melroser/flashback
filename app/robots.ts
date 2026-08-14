import type { MetadataRoute } from 'next';

/**
 * One of three indexing layers, alongside the X-Robots-Tag header and the page
 * meta tag. NONE of them is a security control: authentication is the boundary.
 * This only keeps the archive out of search results.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  };
}
