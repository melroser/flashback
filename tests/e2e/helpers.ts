import type { Page } from '@playwright/test';

export const CODE = process.env.FB_CODE ?? '';
export const SECRET = process.env.FB_SECRET ?? '';

if (!CODE || !SECRET) {
  throw new Error('Set FB_CODE and FB_SECRET before running the browser tests.');
}

/** Sign in as an attendee through the real form. */
export async function signInAttendee(page: Page) {
  await page.goto('/');
  await page.getByLabel(/access code/i).fill(CODE);
  await page.getByRole('button', { name: /enter/i }).click();
  await page.waitForURL('**/archive', { timeout: 30_000 });
}

/** Sign in as an organizer through the real form. */
export async function signInOrganizer(page: Page) {
  await page.goto('/admin');
  await page.getByLabel(/organizer key/i).fill(SECRET);
  await page.getByRole('button', { name: /open the gallery/i }).click();
  await page.waitForURL('**/admin', { timeout: 30_000 });
}
