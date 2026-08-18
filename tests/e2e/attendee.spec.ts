import { expect, test } from '@playwright/test';
import { signInAttendee, CODE } from './helpers';

test.describe('attendee archive', () => {
  test('a wrong code is refused in-page, not as raw JSON', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/access code/i).fill('WRONGWRONG');
    await page.getByRole('button', { name: /enter/i }).click();
    await expect(page.getByText(/doesn.t work/i)).toBeVisible();
    await expect(page).not.toHaveURL(/archive/);
    // Never dump an API body at the user.
    await expect(page.locator('body')).not.toContainText('{"error"');
  });

  test('the grid loads from the manifest and images actually decode', async ({ page }) => {
    await signInAttendee(page);
    const imgs = page.locator('ul img');
    await expect(imgs.first()).toBeVisible();
    expect(await imgs.count()).toBeGreaterThan(10);

    // naturalWidth > 0 proves the bytes decoded, not just that a tag exists.
    const decoded = await imgs.first().evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(decoded).toBeGreaterThan(0);

    await expect(page.getByText(/QLK 001/)).toBeVisible();
    await expect(page.getByText(/disappears in/i)).toBeVisible();
    await expect(page.getByText(/private, temporary archive/i)).toBeVisible();
    await expect(page.getByText(/built with plur/i)).toBeVisible();
  });

  test('lightbox opens, renders the full derivative, and closes on Escape', async ({ page }) => {
    await signInAttendee(page);
    await page.locator('ul img').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const full = dialog.locator('img');
    await expect(full).toBeVisible();
    await expect(full).toHaveAttribute('src', /\/api\/media\/[A-Za-z0-9_-]{22}\?v=full/);
    expect(await full.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // The lightbox is the photograph and nothing else. No camera-data readout.
    await expect(dialog.getByText(/camera data/i)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('the video is present, muted and not autoplaying', async ({ page }) => {
    await signInAttendee(page);
    const video = page.locator('video');
    await expect(video).toBeVisible();
    expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
    expect(await video.evaluate((v: HTMLVideoElement) => v.autoplay)).toBe(false);
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  });

  test('removal hides the photo immediately, then it is restored', async ({ page, request }) => {
    await signInAttendee(page);

    // Target the LAST tile so a failure cannot bury QLK 001.
    const tiles = page.getByRole('button', { name: /request removal/i });
    // Wait for the manifest to land first. Counting straight after sign-in raced the
    // client fetch and returned 0, so the assertion below compared against -1 and
    // the test failed AFTER hiding a real item but BEFORE its restore step.
    await expect(tiles.first()).toBeVisible();
    const n = await tiles.count();
    expect(n).toBeGreaterThan(0);
    await tiles.nth(n - 1).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/don.t have to explain/i)).toBeVisible();

    // Capture which id we are about to hide, so we can put it back.
    const hiddenId = await page.evaluate(async () => {
      const r = await fetch('/api/grid');
      const d = (await r.json()) as { items: Array<{ mediaId: string }> };
      return d.items[d.items.length - 1]?.mediaId ?? '';
    });

    await dialog.getByRole('button', { name: /hide it now/i }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: /request removal/i })).toHaveCount(n - 1);

    // It is genuinely gone for attendees, not just removed from the DOM.
    const res = await request.get(`/api/media/${hiddenId}?v=full`);
    expect(res.status()).toBe(404);

    // Cleanup: restore through the organizer API so the archive is left clean.
    const login = await request.post('/api/admin/session', {
      form: { secret: process.env.FB_SECRET ?? '' },
      maxRedirects: 0,
    });
    expect([200, 303]).toContain(login.status());
    const restore = await request.post(`/api/admin/media/${hiddenId}/visibility`, {
      form: { hidden: 'false', confirmPending: 'yes' },
      maxRedirects: 0,
    });
    expect([200, 303]).toContain(restore.status());
    await request.post('/api/admin/removals/review', {
      form: { all: 'true', status: 'DISMISSED' },
      maxRedirects: 0,
    });
  });

  test('no download affordances and right-click is suppressed', async ({ page }) => {
    await signInAttendee(page);
    const img = page.locator('ul img').first();
    await expect(img).toHaveAttribute('draggable', 'false');
    const prevented = await img.evaluate((el) => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(true);
    await expect(page.getByRole('link', { name: /download/i })).toHaveCount(0);
  });

  test('the code screen shows no media before sign-in', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('img')).toHaveCount(0);
    await expect(page.locator('video')).toHaveCount(0);
    await expect(page.getByLabel(/access code/i)).toBeVisible();
    expect(CODE.length).toBeGreaterThan(7);
  });
});
