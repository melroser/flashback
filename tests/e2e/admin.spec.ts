import { expect, test } from '@playwright/test';
import { signInAttendee, signInOrganizer, SECRET } from './helpers';

/**
 * Real clicks on the admin controls.
 *
 * This file exists because of a specific failure: the Origin check rejected
 * requests that omit the header, which browsers do on same-origin form
 * submissions, so every button here returned {"error":"FORBIDDEN"} while the
 * curl suite passed. Anything that submits a form gets clicked for real below.
 */
test.describe('organizer portal', () => {
  test('signs in and shows the counters', async ({ page }) => {
    await signInOrganizer(page);
    await expect(page.getByText(/pending removals/i)).toBeVisible();
    await expect(page.getByText(/^photos$/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /disable archive/i })).toBeVisible();
  });

  test('a wrong key is refused', async ({ page }) => {
    await page.goto('/admin');
    await page.getByLabel(/organizer key/i).fill(`${SECRET}wrong`);
    await page.getByRole('button', { name: /open the gallery/i }).click();
    await expect(page.getByLabel(/organizer key/i)).toBeVisible();
    await expect(page.getByText(/pending removals/i)).toHaveCount(0);
  });

  test('hide then restore actually works from a click', async ({ page }) => {
    await signInOrganizer(page);

    // Operate on the LAST tile so a failure cannot leave QLK 001 hidden.
    const hideButtons = page.getByRole('button', { name: /^hide$/i });
    const count = await hideButtons.count();
    expect(count).toBeGreaterThan(0);

    await hideButtons.nth(count - 1).click();
    await page.waitForURL('**/admin');

    // No FORBIDDEN body — that was the bug.
    await expect(page.locator('body')).not.toContainText('FORBIDDEN');
    await expect(page.getByText(/item\(s\) currently hidden/i)).toBeVisible();

    // Put it back.
    const restore = page.getByRole('button', { name: /^restore$/i }).first();
    await expect(restore).toBeVisible();
    await restore.click();
    await page.waitForURL('**/admin');
    await expect(page.locator('body')).not.toContainText('FORBIDDEN');
    await expect(page.getByText(/item\(s\) currently hidden/i)).toHaveCount(0);
  });

  test('disable then enable, and the counter flips', async ({ page }) => {
    await signInOrganizer(page);
    await page.getByRole('button', { name: /disable archive/i }).click();
    await page.waitForURL('**/admin');
    await expect(page.locator('body')).not.toContainText('FORBIDDEN');
    await expect(page.getByText('DISABLED')).toBeVisible();

    await page.getByRole('button', { name: /enable archive/i }).click();
    await page.waitForURL('**/admin');
    await expect(page.getByText('LIVE')).toBeVisible();
  });

  test('delete refuses to fire without the typed confirmation', async ({ page }) => {
    await signInOrganizer(page);
    await page.getByRole('textbox', { name: '' }).first().isVisible().catch(() => {});
    const confirmField = page.locator('input[name="confirm"]').last();
    await confirmField.fill('nope');
    await page
      .getByRole('button', { name: /delete everything/i })
      .click();
    // Must be refused, and must NOT have deleted anything.
    await expect(page.locator('body')).toContainText(/CONFIRM_REQUIRED|Type exactly/i);
    await page.goto('/admin');
    await expect(page.getByText(/pending removals/i)).toBeVisible();
  });

  test('logout returns to the organizer sign-in, not the guest prompt', async ({ page }) => {
    await signInOrganizer(page);
    await page.getByRole('button', { name: /log out/i }).click();
    await page.waitForURL('**/admin');
    // The organizer key field, NOT the attendee access code field.
    await expect(page.getByLabel(/organizer key/i)).toBeVisible();
    await expect(page.getByLabel(/access code/i)).toHaveCount(0);
  });

  test('an attendee session is told what to do, not scolded', async ({ page }) => {
    await signInAttendee(page);
    await page.goto('/admin');
    await expect(page.getByText(/signed in as an attendee/i)).toBeVisible();
    await expect(page.getByLabel(/organizer key/i)).toBeVisible();
  });
});
