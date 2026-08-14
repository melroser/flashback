import { withOrganizer } from '@/lib/auth/organizer';
import { writeConfig } from '@/lib/blobs/meta';
import { writeCodeRecord } from '@/lib/blobs/seed';
import { deriveCodeRecord, generateCode } from '@/lib/access/code';
import { siteOrigin } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] as string);
}

export const POST = withOrganizer(async (_req, { config }) => {
  const code = generateCode();
  const nextVersion = config.codeVersion + 1;

  // Order matters. Write the code record FIRST, then the bumped codeVersion. If
  // the second write fails, the old code still validates and old sessions still
  // work: degraded but coherent. The reverse order would leave a window with no
  // valid code at all.
  await writeCodeRecord(await deriveCodeRecord(code, nextVersion));
  await writeConfig({ ...config, codeVersion: nextVersion });

  const origin = siteOrigin() ?? '';
  const expires = new Date(config.expiresAt).toUTCString();
  const distribution = [
    'FLASHBACK',
    config.eventName,
    'Private archive:',
    origin,
    'Access code:',
    code,
  ].join('\n');

  // Rendered directly rather than redirected, so the plaintext never enters a URL,
  // a redirect chain, or browser history. It is not persisted and never logged, so
  // this render is the only place it exists.
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow"><title>NEW CODE</title>',
    '<style>',
    'body{background:#080809;color:#E8E5DE;font:15px/1.6 ui-monospace,Menlo,monospace;margin:0;padding:2rem}',
    '.k{font-size:2rem;letter-spacing:.2em;color:#F5F3EE;background:#111114;border:1px solid #1C1C21;padding:1rem;display:inline-block;margin:1rem 0}',
    'textarea{width:100%;max-width:34rem;height:9rem;background:#111114;color:#E8E5DE;border:1px solid #1C1C21;padding:.75rem;font:inherit}',
    'a{color:#39FF6A}.w{color:#FF2D2D}',
    '.lbl{font-size:.7rem;letter-spacing:.28em;text-transform:uppercase;color:#A8A29A}',
    '</style></head><body>',
    '<h1 class="lbl">New attendee code</h1>',
    '<div class="k">' + escapeHtml(code) + '</div>',
    '<p class="w">Copy this now. It is never stored in plaintext, so it cannot be shown again.</p>',
    '<p style="color:#A8A29A">Every attendee session issued before this rotation is now invalid. Expires ' +
      escapeHtml(expires) +
      '.</p>',
    '<h2 class="lbl">Send this to attendees</h2>',
    '<textarea readonly onclick="this.select()">' + escapeHtml(distribution) + '</textarea>',
    '<p><a href="/admin">Back to admin</a></p>',
    '</body></html>',
  ].join('');

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
});
