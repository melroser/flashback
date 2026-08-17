import { defineConfig, devices } from '@playwright/test';

/**
 * These run against the DEPLOYED site, not a local dev server.
 *
 * Two reasons. Netlify Dev uses a sandboxed blob store that cannot see production
 * media, and the strong-consistency behaviour the disable control depends on only
 * exists in production.
 *
 * WebKit is not optional here. The Origin-header bug that killed every button on
 * the admin page only reproduced in a real browser form submission, and curl-based
 * tests set Origin explicitly, so they verified a code path no browser takes.
 */
const baseURL = process.env.BASE_URL ?? 'https://flashback-qlick.netlify.app';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // these mutate one shared production archive
  workers: 1,
  retries: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: false,
  },
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] } },
  ],
});
