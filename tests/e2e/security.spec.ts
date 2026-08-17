import { expect, test } from '@playwright/test';
import { signInAttendee } from './helpers';

test.describe('boundaries, in a real browser', () => {
  test('a fresh context cannot reach the archive', async ({ browser }) => {
    const ctx = await browser.newContext(); // no cookies
    const page = await ctx.newPage();
    await page.goto('/archive');
    // Redirected to the code screen, with no media in the markup.
    await expect(page.getByLabel(/access code/i)).toBeVisible();
    await expect(page.locator('ul img')).toHaveCount(0);
    expect(await page.content()).not.toContain('data:image/jpeg');
    await ctx.close();
  });

  test('a media URL copied into a clean context fails', async ({ browser, page }) => {
    await signInAttendee(page);
    const src = await page.locator('video').getAttribute('src');
    expect(src).toBeTruthy();

    const incognito = await browser.newContext();
    const fresh = await incognito.newPage();
    const res = await fresh.goto(src as string);
    expect(res?.status()).toBe(401);
    await incognito.close();
  });

  test('grid manifest is refused without a session', async ({ browser }) => {
    const ctx = await browser.newContext();
    const res = await ctx.request.get('/api/grid');
    expect(res.status()).toBe(401);
    await ctx.close();
  });

  test('a guessed media id yields 404, not a hint', async ({ page }) => {
    await signInAttendee(page);
    const res = await page.request.get('/api/media/AAAAAAAAAAAAAAAAAAAAAA?v=full');
    expect(res.status()).toBe(404);
    expect((await res.body()).byteLength).toBeLessThan(200);
  });

  test('admin state cannot be changed from another origin', async ({ page }) => {
    await signInAttendee(page);
    // Attendee session on an admin route: recognised, still refused.
    const res = await page.request.post('/api/admin/state', {
      form: { state: 'DISABLED' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
  });

  test('media responses are private and never shared-cacheable', async ({ page }) => {
    await signInAttendee(page);
    const src = await page.locator('ul img').first().evaluate(async () => {
      const r = await fetch('/api/grid');
      const d = (await r.json()) as { items: Array<{ mediaId: string }> };
      return `/api/media/${d.items[0]?.mediaId}?v=full`;
    });
    const res = await page.request.get(src);
    const cc = res.headers()['cache-control'] ?? '';
    expect(cc).toContain('private');
    expect(cc).not.toContain('public');
    expect(cc).not.toContain('s-maxage');
    expect(res.headers()['vary'] ?? '').toMatch(/cookie/i);
  });

  test('security headers are present on a real navigation', async ({ page }) => {
    const res = await page.goto('/');
    const h = res?.headers() ?? {};
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-robots-tag']).toMatch(/noindex/);
    expect(h['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(h['strict-transport-security']).toMatch(/max-age=\d{8,}/);
  });
});
